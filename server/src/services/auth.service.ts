import crypto from 'node:crypto';
import {
  toCanonicalIsoUtc,
  type AuthTokenResponse,
  type AuthUser,
  type ChangePasswordRequest,
  type ClientType,
  type LoginRequest,
  type RegisterRequest,
  type SessionInfo,
  type UserRole,
} from '@bibliolisa/shared';
import { and, desc, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { jwtVerify, SignJWT } from 'jose';
import type { DatabaseContext } from '../db/client.js';
import { refreshTokens, users, type RefreshTokenRow, type UserRow } from '../db/schema.js';
import { AppError } from '../plugins/error-handler.js';

export const SCRYPT_N = 32768;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const SCRYPT_KEYLEN = 64;
export const SCRYPT_MAXMEM = 64 * 1024 * 1024;

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const MEDIA_TOKEN_TTL_SECONDS = 20 * 60;
export const WEB_REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;
export const MOBILE_REFRESH_TTL_SECONDS = 365 * 24 * 60 * 60;
export const REFRESH_GRACE_WINDOW_MS = 30 * 1000;
const REFRESH_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const DUMMY_PASSWORD_HASH = `$scrypt$n=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${Buffer.alloc(16, 1).toString('base64')}$${Buffer.alloc(SCRYPT_KEYLEN, 2).toString('base64')}`;

function scryptAsync(
  password: string,
  salt: Buffer,
  keylen: number,
  options: crypto.ScryptOptions
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) {
        reject(err);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });

  return `$scrypt$n=${SCRYPT_N},r=${SCRYPT_R},p=${SCRYPT_P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string
): Promise<boolean> {
  const parts = storedHash.split('$');
  if (parts.length !== 5 || parts[1] !== 'scrypt') {
    return false;
  }

  const paramsPart = parts[2];
  const saltB64 = parts[3];
  const hashB64 = parts[4];
  if (!paramsPart || !saltB64 || !hashB64) {
    return false;
  }

  const paramMatch = /^n=(\d+),r=(\d+),p=(\d+)$/.exec(paramsPart);
  if (!paramMatch) {
    return false;
  }

  const n = Number(paramMatch[1]);
  const r = Number(paramMatch[2]);
  const p = Number(paramMatch[3]);
  if (
    !Number.isInteger(n) ||
    !Number.isInteger(r) ||
    !Number.isInteger(p) ||
    n < 2 ||
    r < 1 ||
    p < 1
  ) {
    return false;
  }

  const salt = Buffer.from(saltB64, 'base64');
  const expectedHash = Buffer.from(hashB64, 'base64');
  if (salt.length === 0 || expectedHash.length === 0) {
    return false;
  }

  const derived = await scryptAsync(password, salt, expectedHash.length, {
    N: n,
    r,
    p,
    maxmem: Math.max(SCRYPT_MAXMEM, 256 * n * r),
  });

  if (derived.length !== expectedHash.length) {
    return false;
  }

  return crypto.timingSafeEqual(derived, expectedHash);
}

export function hashRefreshToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

export interface AccessTokenClaims {
  sub: string;
  username: string;
  role: UserRole;
}

export interface MediaTokenClaims {
  sub: string;
  scope: 'media:read';
}

export interface IssuedAuthBundle {
  response: AuthTokenResponse;
  refreshToken: string;
  mediaToken: string | null;
  clientType: ClientType;
}

export interface AuthServiceOptions {
  dbCtx: DatabaseContext;
  jwtSecret: string;
  allowRegistration: boolean;
  now?: () => Date;
}

function toAuthUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
  };
}

export class AuthService {
  private readonly dbCtx: DatabaseContext;
  private readonly secretKey: Uint8Array;
  private readonly allowRegistration: boolean;
  private readonly now: () => Date;
  private lastPruneAtMs: number | null = null;

  constructor(options: AuthServiceOptions) {
    this.dbCtx = options.dbCtx;
    this.secretKey = new TextEncoder().encode(options.jwtSecret);
    this.allowRegistration = options.allowRegistration;
    this.now = options.now ?? (() => new Date());
  }

  getUserCount(): number {
    const row = this.dbCtx.sqlite
      .prepare('SELECT COUNT(*) AS count FROM users')
      .get() as { count: number };
    return row.count;
  }

  isRegistrationEffectivelyAllowed(): boolean {
    return this.allowRegistration || this.getUserCount() === 0;
  }

  pruneExpiredAndRevokedTokens(revokedRetentionDays = 7): number {
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const cutoffIso = new Date(
      nowDate.getTime() - revokedRetentionDays * 86_400_000
    ).toISOString();

    const info = this.dbCtx.sqlite
      .prepare(
        `DELETE FROM refresh_tokens
         WHERE expires_at <= ?
            OR (revoked_at IS NOT NULL AND revoked_at <= ?)`
      )
      .run(nowIso, cutoffIso);
    this.lastPruneAtMs = nowDate.getTime();
    return info.changes;
  }

  private maybePruneTokens(): void {
    const nowMs = this.now().getTime();
    if (
      this.lastPruneAtMs === null ||
      Math.abs(nowMs - this.lastPruneAtMs) >= REFRESH_PRUNE_INTERVAL_MS
    ) {
      this.pruneExpiredAndRevokedTokens();
    }
  }

  async signAccessToken(
    user: Pick<UserRow, 'id' | 'username' | 'role'>,
    nowDate = this.now()
  ): Promise<{ accessToken: string; accessTokenExpiresAt: string }> {
    const iat = Math.floor(nowDate.getTime() / 1000);
    const exp = iat + ACCESS_TOKEN_TTL_SECONDS;
    const accessToken = await new SignJWT({
      username: user.username,
      role: user.role,
      type: 'access',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(user.id)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.secretKey);

    return {
      accessToken,
      accessTokenExpiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async signMediaToken(userId: string, nowDate = this.now()): Promise<string> {
    const iat = Math.floor(nowDate.getTime() / 1000);
    const exp = iat + MEDIA_TOKEN_TTL_SECONDS;
    return new SignJWT({
      scope: 'media:read',
      type: 'media',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(this.secretKey);
  }

  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        algorithms: ['HS256'],
        currentDate: this.now(),
      });

      if (
        payload.type !== 'access' ||
        typeof payload.sub !== 'string' ||
        typeof payload.username !== 'string' ||
        (payload.role !== 'admin' && payload.role !== 'user')
      ) {
        throw new AppError(401, 'UNAUTHORIZED', 'Ungültiges Access Token.');
      }

      return {
        sub: payload.sub,
        username: payload.username,
        role: payload.role,
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        401,
        'UNAUTHORIZED',
        'Access Token ungültig oder abgelaufen.'
      );
    }
  }

  async verifyMediaToken(token: string): Promise<MediaTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, this.secretKey, {
        algorithms: ['HS256'],
        currentDate: this.now(),
      });

      if (
        payload.type !== 'media' ||
        payload.scope !== 'media:read' ||
        typeof payload.sub !== 'string'
      ) {
        throw new AppError(401, 'UNAUTHORIZED', 'Ungültiges Media Token.');
      }

      return {
        sub: payload.sub,
        scope: 'media:read',
      };
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw new AppError(
        401,
        'UNAUTHORIZED',
        'Media Token ungültig oder abgelaufen.'
      );
    }
  }

  private getRefreshExpiryIso(clientType: ClientType, nowDate: Date): string {
    const ttlSeconds =
      clientType === 'mobile'
        ? MOBILE_REFRESH_TTL_SECONDS
        : WEB_REFRESH_TTL_SECONDS;
    return new Date(nowDate.getTime() + ttlSeconds * 1000).toISOString();
  }

  private async buildAuthBundle(
    userRow: UserRow,
    rawRefreshToken: string,
    clientType: ClientType,
    nowDate: Date
  ): Promise<IssuedAuthBundle> {
    const { accessToken, accessTokenExpiresAt } = await this.signAccessToken(
      userRow,
      nowDate
    );
    const mediaToken =
      clientType === 'web'
        ? await this.signMediaToken(userRow.id, nowDate)
        : null;

    const response: AuthTokenResponse = {
      user: toAuthUser(userRow),
      accessToken,
      accessTokenExpiresAt,
      ...(clientType === 'mobile' ? { refreshToken: rawRefreshToken } : {}),
    };

    return {
      response,
      refreshToken: rawRefreshToken,
      mediaToken,
      clientType,
    };
  }

  async register(input: RegisterRequest): Promise<IssuedAuthBundle> {
    if (this.getUserCount() > 0 && !this.allowRegistration) {
      throw new AppError(
        403,
        'REGISTRATION_DISABLED',
        'Die Registrierung neuer Benutzer ist deaktiviert.'
      );
    }

    const passwordHash = await hashPassword(input.password);
    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const userId = crypto.randomUUID();
    const rawRefreshToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const refreshId = crypto.randomUUID();
    const expiresAt = this.getRefreshExpiryIso(input.clientType, nowDate);

    const createdUser = this.dbCtx.sqlite.transaction((): UserRow => {
      const existingCount = this.getUserCount();
      if (existingCount > 0 && !this.allowRegistration) {
        throw new AppError(
          403,
          'REGISTRATION_DISABLED',
          'Die Registrierung neuer Benutzer ist deaktiviert.'
        );
      }

      const existingUsername = this.dbCtx.sqlite
        .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
        .get(input.username) as { id: string } | undefined;
      if (existingUsername) {
        throw new AppError(
          409,
          'USERNAME_TAKEN',
          'Dieser Benutzername ist bereits vergeben.'
        );
      }

      const normalizedEmail = input.email ?? null;
      if (normalizedEmail !== null) {
        const existingEmail = this.dbCtx.sqlite
          .prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE')
          .get(normalizedEmail) as { id: string } | undefined;
        if (existingEmail) {
          throw new AppError(
            409,
            'EMAIL_TAKEN',
            'Diese E-Mail-Adresse ist bereits registriert.'
          );
        }
      }

      const role: UserRole = existingCount === 0 ? 'admin' : 'user';

      this.dbCtx.db
        .insert(users)
        .values({
          id: userId,
          username: input.username,
          displayName: input.displayName ?? null,
          email: normalizedEmail,
          passwordHash,
          role,
          createdAt: nowIso,
          updatedAt: nowIso,
        })
        .run();

      this.dbCtx.db
        .insert(refreshTokens)
        .values({
          id: refreshId,
          userId,
          tokenHash,
          deviceId: input.deviceId ?? null,
          deviceName: input.deviceName ?? null,
          clientType: input.clientType,
          replacedById: null,
          graceUntil: null,
          expiresAt,
          revokedAt: null,
          lastUsedAt: nowIso,
          createdAt: nowIso,
        })
        .run();

      const inserted = this.dbCtx.db
        .select()
        .from(users)
        .where(eq(users.id, userId))
        .get();
      if (!inserted) {
        throw new Error('Erstellter Benutzer konnte nicht geladen werden.');
      }
      return inserted;
    })();

    this.maybePruneTokens();

    return this.buildAuthBundle(
      createdUser,
      rawRefreshToken,
      input.clientType,
      nowDate
    );
  }

  async login(input: LoginRequest): Promise<IssuedAuthBundle> {
    const userRow = this.dbCtx.db
      .select()
      .from(users)
      .where(sql`${users.username} = ${input.username} COLLATE NOCASE`)
      .get();

    if (!userRow) {
      // Konstantes Timing unabhängig davon, ob der Benutzername existiert
      await verifyPassword(input.password, DUMMY_PASSWORD_HASH);
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'Ungültiger Benutzername oder ungültiges Passwort.'
      );
    }

    const validPassword = await verifyPassword(
      input.password,
      userRow.passwordHash
    );
    if (!validPassword) {
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'Ungültiger Benutzername oder ungültiges Passwort.'
      );
    }

    const nowDate = this.now();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const rawRefreshToken = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashRefreshToken(rawRefreshToken);
    const refreshId = crypto.randomUUID();
    const expiresAt = this.getRefreshExpiryIso(input.clientType, nowDate);

    this.dbCtx.db
      .insert(refreshTokens)
      .values({
        id: refreshId,
        userId: userRow.id,
        tokenHash,
        deviceId: input.deviceId ?? null,
        deviceName: input.deviceName ?? null,
        clientType: input.clientType,
        replacedById: null,
        graceUntil: null,
        expiresAt,
        revokedAt: null,
        lastUsedAt: nowIso,
        createdAt: nowIso,
      })
      .run();

    this.maybePruneTokens();

    return this.buildAuthBundle(
      userRow,
      rawRefreshToken,
      input.clientType,
      nowDate
    );
  }

  private revokeCompromisedScope(
    tokenRow: RefreshTokenRow,
    nowIso: string
  ): void {
    this.dbCtx.sqlite.transaction(() => {
      // Immer die gesamte Weiterleitungs-Kette ausgehend vom kompromittierten Token widerrufen
      let cursorId: string | null = tokenRow.id;
      const visited = new Set<string>();
      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId);
        const row = this.dbCtx.db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, cursorId))
          .get();
        if (!row) break;
        if (row.revokedAt === null) {
          this.dbCtx.db
            .update(refreshTokens)
            .set({ revokedAt: nowIso, graceUntil: null })
            .where(eq(refreshTokens.id, row.id))
            .run();
        }
        cursorId = row.replacedById;
      }

      if (tokenRow.deviceId !== null) {
        this.dbCtx.db
          .update(refreshTokens)
          .set({ revokedAt: nowIso, graceUntil: null })
          .where(
            and(
              eq(refreshTokens.userId, tokenRow.userId),
              eq(refreshTokens.deviceId, tokenRow.deviceId),
              isNull(refreshTokens.revokedAt)
            )
          )
          .run();
      } else {
        this.dbCtx.db
          .update(refreshTokens)
          .set({ revokedAt: nowIso, graceUntil: null })
          .where(
            and(
              eq(refreshTokens.userId, tokenRow.userId),
              isNull(refreshTokens.revokedAt)
            )
          )
          .run();
      }
    })();
  }

  async refresh(
    rawRefreshToken: string,
    requestedClientType?: ClientType
  ): Promise<IssuedAuthBundle> {
    const nowDate = this.now();
    const nowMs = nowDate.getTime();
    const nowIso = toCanonicalIsoUtc(nowDate);
    const tokenHash = hashRefreshToken(rawRefreshToken);

    const existingRow = this.dbCtx.db
      .select()
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .get();

    if (!existingRow) {
      throw new AppError(
        401,
        'INVALID_REFRESH_TOKEN',
        'Refresh Token ungültig.'
      );
    }

    if (
      requestedClientType !== undefined &&
      existingRow.clientType !== requestedClientType
    ) {
      throw new AppError(
        401,
        'INVALID_REFRESH_TOKEN',
        'Refresh Token stimmt nicht mit dem Client-Typ überein.'
      );
    }

    if (existingRow.revokedAt !== null) {
      throw new AppError(
        401,
        'REFRESH_TOKEN_REVOKED',
        'Refresh Token wurde bereits widerrufen.'
      );
    }

    if (Date.parse(existingRow.expiresAt) <= nowMs) {
      throw new AppError(
        401,
        'REFRESH_TOKEN_EXPIRED',
        'Refresh Token ist abgelaufen.'
      );
    }

    // Erneute Nutzung eines bereits rotierten Tokens prüfen (Grace-Window vs. Token-Diebstahl)
    if (existingRow.replacedById !== null) {
      const graceUntilMs =
        existingRow.graceUntil !== null
          ? Date.parse(existingRow.graceUntil)
          : Number.NaN;
      const withinGraceWindow =
        !Number.isNaN(graceUntilMs) && nowMs <= graceUntilMs;

      if (!withinGraceWindow) {
        this.revokeCompromisedScope(existingRow, nowIso);
        throw new AppError(
          401,
          'REFRESH_TOKEN_REUSE_DETECTED',
          'Wiederverwendung eines abgelaufenen Refresh Tokens erkannt. Session wurde widerrufen.'
        );
      }
    }

    const newRawRefreshToken = crypto.randomBytes(32).toString('base64url');
    const newTokenHash = hashRefreshToken(newRawRefreshToken);
    const newTokenId = crypto.randomUUID();
    const graceUntilIso = new Date(
      nowMs + REFRESH_GRACE_WINDOW_MS
    ).toISOString();
    const newExpiresAt = this.getRefreshExpiryIso(
      existingRow.clientType,
      nowDate
    );

    const outcome = this.dbCtx.sqlite.transaction(
      (): { status: 'ok'; userRow: UserRow } | { status: 'compromised' } | { status: 'invalid' } => {
        const freshExisting = this.dbCtx.db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, existingRow.id))
          .get();

        if (!freshExisting || freshExisting.revokedAt !== null) {
          return { status: 'invalid' };
        }

        let headToken: RefreshTokenRow = freshExisting;

        if (freshExisting.replacedById !== null) {
          const graceMs =
            freshExisting.graceUntil !== null
              ? Date.parse(freshExisting.graceUntil)
              : Number.NaN;
          if (Number.isNaN(graceMs) || nowMs > graceMs) {
            return { status: 'compromised' };
          }

          // Aktiven Endpunkt (Head) der Rotationskette ermitteln
          const visited = new Set<string>([freshExisting.id]);
          let nextId: string | null = freshExisting.replacedById;
          while (nextId) {
            if (visited.has(nextId)) {
              return { status: 'compromised' };
            }
            visited.add(nextId);
            const candidate = this.dbCtx.db
              .select()
              .from(refreshTokens)
              .where(eq(refreshTokens.id, nextId))
              .get();
            if (!candidate) {
              return { status: 'invalid' };
            }
            if (
              candidate.revokedAt !== null ||
              Date.parse(candidate.expiresAt) <= nowMs
            ) {
              return { status: 'invalid' };
            }
            headToken = candidate;
            nextId = candidate.replacedById;
          }

          // Einmaliges Grace-Retry verbraucht das Kulanzfenster auf dem alten Token
          this.dbCtx.db
            .update(refreshTokens)
            .set({ graceUntil: null })
            .where(eq(refreshTokens.id, freshExisting.id))
            .run();
        }

        const userRow = this.dbCtx.db
          .select()
          .from(users)
          .where(eq(users.id, headToken.userId))
          .get();
        if (!userRow) {
          return { status: 'invalid' };
        }

        this.dbCtx.db
          .insert(refreshTokens)
          .values({
            id: newTokenId,
            userId: headToken.userId,
            tokenHash: newTokenHash,
            deviceId: headToken.deviceId,
            deviceName: headToken.deviceName,
            clientType: headToken.clientType,
            replacedById: null,
            graceUntil: null,
            expiresAt: newExpiresAt,
            revokedAt: null,
            lastUsedAt: nowIso,
            createdAt: nowIso,
          })
          .run();

        this.dbCtx.db
          .update(refreshTokens)
          .set({
            replacedById: newTokenId,
            graceUntil: graceUntilIso,
            lastUsedAt: nowIso,
          })
          .where(eq(refreshTokens.id, headToken.id))
          .run();

        return { status: 'ok', userRow };
      }
    )();

    if (outcome.status === 'compromised') {
      this.revokeCompromisedScope(existingRow, nowIso);
      throw new AppError(
        401,
        'REFRESH_TOKEN_REUSE_DETECTED',
        'Wiederverwendung eines abgelaufenen Refresh Tokens erkannt. Session wurde widerrufen.'
      );
    }

    if (outcome.status === 'invalid') {
      throw new AppError(
        401,
        'REFRESH_TOKEN_REVOKED',
        'Refresh Token ist nicht mehr gültig.'
      );
    }

    return this.buildAuthBundle(
      outcome.userRow,
      newRawRefreshToken,
      existingRow.clientType,
      nowDate
    );
  }

  logout(userId: string, rawRefreshToken?: string): void {
    if (!rawRefreshToken) {
      return;
    }

    const nowIso = toCanonicalIsoUtc(this.now());
    const tokenHash = hashRefreshToken(rawRefreshToken);

    this.dbCtx.sqlite.transaction(() => {
      const row = this.dbCtx.db
        .select()
        .from(refreshTokens)
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            eq(refreshTokens.userId, userId)
          )
        )
        .get();
      if (!row) {
        return;
      }

      let cursorId: string | null = row.id;
      const visited = new Set<string>();
      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId);
        const current = this.dbCtx.db
          .select()
          .from(refreshTokens)
          .where(eq(refreshTokens.id, cursorId))
          .get();
        if (!current) break;
        this.dbCtx.db
          .update(refreshTokens)
          .set({ revokedAt: nowIso, graceUntil: null })
          .where(eq(refreshTokens.id, current.id))
          .run();
        cursorId = current.replacedById;
      }
    })();
  }

  getMe(userId: string): AuthUser {
    const userRow = this.dbCtx.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();

    if (!userRow) {
      throw new AppError(401, 'UNAUTHORIZED', 'Benutzerkonto nicht gefunden.');
    }

    return toAuthUser(userRow);
  }

  listSessions(
    userId: string,
    currentRefreshToken?: string,
    currentDeviceId?: string
  ): SessionInfo[] {
    const nowIso = toCanonicalIsoUtc(this.now());
    const currentHash = currentRefreshToken
      ? hashRefreshToken(currentRefreshToken)
      : null;

    const rows = this.dbCtx.db
      .select()
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          isNull(refreshTokens.replacedById),
          gt(refreshTokens.expiresAt, nowIso)
        )
      )
      .orderBy(desc(sql`COALESCE(${refreshTokens.lastUsedAt}, ${refreshTokens.createdAt})`))
      .all();

    return rows.map((row) => ({
      id: row.id,
      deviceId: row.deviceId,
      deviceName: row.deviceName,
      clientType: row.clientType,
      lastUsedAt: row.lastUsedAt,
      expiresAt: row.expiresAt,
      createdAt: row.createdAt,
      isCurrent:
        currentHash !== null
          ? row.tokenHash === currentHash
          : currentDeviceId !== undefined &&
            row.deviceId !== null &&
            row.deviceId === currentDeviceId,
    }));
  }

  revokeSession(userId: string, sessionId: string): void {
    const nowIso = toCanonicalIsoUtc(this.now());

    this.dbCtx.sqlite.transaction(() => {
      const target = this.dbCtx.db
        .select()
        .from(refreshTokens)
        .where(
          and(eq(refreshTokens.id, sessionId), eq(refreshTokens.userId, userId))
        )
        .get();

      if (!target) {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'Session nicht gefunden.');
      }

      if (target.revokedAt !== null) {
        return;
      }

      const idsToRevoke = new Set<string>();
      const queue: string[] = [target.id];

      while (queue.length > 0) {
        const currentId = queue.pop()!;
        if (idsToRevoke.has(currentId)) continue;
        idsToRevoke.add(currentId);

        const current = this.dbCtx.db
          .select()
          .from(refreshTokens)
          .where(
            and(
              eq(refreshTokens.id, currentId),
              eq(refreshTokens.userId, userId)
            )
          )
          .get();
        if (current?.replacedById && !idsToRevoke.has(current.replacedById)) {
          queue.push(current.replacedById);
        }

        const predecessors = this.dbCtx.db
          .select({ id: refreshTokens.id })
          .from(refreshTokens)
          .where(
            and(
              eq(refreshTokens.userId, userId),
              eq(refreshTokens.replacedById, currentId)
            )
          )
          .all();
        for (const pred of predecessors) {
          if (!idsToRevoke.has(pred.id)) {
            queue.push(pred.id);
          }
        }
      }

      for (const id of idsToRevoke) {
        this.dbCtx.db
          .update(refreshTokens)
          .set({ revokedAt: nowIso, graceUntil: null })
          .where(
            and(
              eq(refreshTokens.id, id),
              eq(refreshTokens.userId, userId),
              isNull(refreshTokens.revokedAt)
            )
          )
          .run();
      }
    })();
  }

  async changePassword(
    userId: string,
    input: ChangePasswordRequest,
    currentRefreshToken?: string,
    currentDeviceId?: string
  ): Promise<void> {
    const userRow = this.dbCtx.db
      .select()
      .from(users)
      .where(eq(users.id, userId))
      .get();

    if (!userRow) {
      throw new AppError(401, 'UNAUTHORIZED', 'Benutzerkonto nicht gefunden.');
    }

    const validCurrent = await verifyPassword(
      input.currentPassword,
      userRow.passwordHash
    );
    if (!validCurrent) {
      throw new AppError(
        401,
        'INVALID_CREDENTIALS',
        'Das aktuelle Passwort ist nicht korrekt.'
      );
    }

    const newHash = await hashPassword(input.newPassword);
    const nowIso = toCanonicalIsoUtc(this.now());
    const currentTokenHash = currentRefreshToken
      ? hashRefreshToken(currentRefreshToken)
      : null;

    this.dbCtx.sqlite.transaction(() => {
      this.dbCtx.db
        .update(users)
        .set({ passwordHash: newHash, updatedAt: nowIso })
        .where(eq(users.id, userId))
        .run();

      if (input.revokeOtherSessions) {
        if (currentTokenHash !== null) {
          this.dbCtx.db
            .update(refreshTokens)
            .set({ revokedAt: nowIso, graceUntil: null })
            .where(
              and(
                eq(refreshTokens.userId, userId),
                isNull(refreshTokens.revokedAt),
                ne(refreshTokens.tokenHash, currentTokenHash)
              )
            )
            .run();
        } else if (currentDeviceId) {
          this.dbCtx.db
            .update(refreshTokens)
            .set({ revokedAt: nowIso, graceUntil: null })
            .where(
              and(
                eq(refreshTokens.userId, userId),
                isNull(refreshTokens.revokedAt),
                sql`(${refreshTokens.deviceId} IS NULL OR ${refreshTokens.deviceId} != ${currentDeviceId})`
              )
            )
            .run();
        } else {
          this.dbCtx.db
            .update(refreshTokens)
            .set({ revokedAt: nowIso, graceUntil: null })
            .where(
              and(
                eq(refreshTokens.userId, userId),
                isNull(refreshTokens.revokedAt)
              )
            )
            .run();
        }
      }
    })();
  }
}
