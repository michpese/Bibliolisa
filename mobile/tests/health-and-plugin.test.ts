import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { checkServerHealth, normalizeServerUrl } from '../src/sync/health-check';

const require = createRequire(import.meta.url);
const withLanNetworkSecurity = require('../plugins/withLanNetworkSecurity.js') as {
  NETWORK_SECURITY_CONFIG_XML: string;
  applyNetworkSecurityToManifest: (manifest: {
    manifest: { application: Array<{ $: Record<string, string> }> };
  }) => { manifest: { application: Array<{ $: Record<string, string> }> } };
  writeNetworkSecurityConfigFile: (platformProjectRoot: string) => string;
};
const withAndroidReleaseSigning = require('../plugins/withAndroidReleaseSigning.js') as {
  applyAndroidReleaseSigning: (contents: string) => string;
};

describe('Server-URL-Normalisierung & Health-Check', () => {
  it('normalisiert gültige http://- und https://-URLs ohne festes LAN-Preset', () => {
    expect(normalizeServerUrl('  https://books.home.lan/  ')).toEqual({
      ok: true,
      url: 'https://books.home.lan',
    });
    expect(normalizeServerUrl('http://192.168.178.42:3000///')).toEqual({
      ok: true,
      url: 'http://192.168.178.42:3000',
    });

    expect(normalizeServerUrl('')).toMatchObject({ ok: false });
    expect(normalizeServerUrl('books.home.lan')).toMatchObject({ ok: false });
    expect(normalizeServerUrl('ftp://books.home.lan')).toMatchObject({ ok: false });
  });

  it('liefert bei 200 OK Latenz, Version und Provider-Status', async () => {
    const mockFetch: typeof fetch = async (input) => {
      expect(String(input)).toBe('https://books.home.lan/api/health');
      return new Response(
        JSON.stringify({
          status: 'ok',
          version: '0.1.0',
          serverTime: '2026-11-21T11:00:00.000Z',
          allowRegistration: true,
          providers: {
            openLibrary: true,
            googleBooks: true,
            hardcover: false,
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const result = await checkServerHealth('https://books.home.lan/', 1500, mockFetch);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.url).toBe('https://books.home.lan');
      expect(result.health.version).toBe('0.1.0');
      expect(result.health.providers.openLibrary).toBe(true);
    }
  });

  it('bricht beim Timeout sauber ab und erkennt TLS-/HTTP-/Schema-Fehler', async () => {
    const slowFetch: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted.');
          err.name = 'AbortError';
          reject(err);
        });
      });

    const timeoutRes = await checkServerHealth('http://10.0.0.5:3000', 50, slowFetch);
    expect(timeoutRes.ok).toBe(false);
    if (!timeoutRes.ok) {
      expect(timeoutRes.kind).toBe('timeout');
    }

    const tlsFetch: typeof fetch = async () => {
      throw new Error('java.security.cert.CertPathValidatorException: Trust anchor for certification path not found');
    };
    const tlsRes = await checkServerHealth('https://books.home.lan', 1500, tlsFetch);
    expect(tlsRes.ok).toBe(false);
    if (!tlsRes.ok) {
      expect(tlsRes.kind).toBe('tls_error');
      expect(tlsRes.message).toContain('Benutzer-CA');
    }

    const badStatusFetch: typeof fetch = async () =>
      new Response('Bad Gateway', { status: 502 });
    const httpRes = await checkServerHealth('https://books.home.lan', 1500, badStatusFetch);
    expect(httpRes.ok).toBe(false);
    if (!httpRes.ok) {
      expect(httpRes.kind).toBe('http_error');
      expect(httpRes.httpStatus).toBe(502);
    }
  });
});

describe('Expo Config Plugin withLanNetworkSecurity', () => {
  it('generiert network_security_config.xml und verknüpft AndroidManifest.xml', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bibliolisa-plugin-'));
    try {
      const xmlPath = withLanNetworkSecurity.writeNetworkSecurityConfigFile(tmpRoot);
      expect(xmlPath).toBe(
        path.join(tmpRoot, 'app', 'src', 'main', 'res', 'xml', 'network_security_config.xml')
      );

      const content = fs.readFileSync(xmlPath, 'utf8');
      expect(content).toContain('<base-config cleartextTrafficPermitted="true">');
      expect(content).toContain('<certificates src="system" />');
      expect(content).toContain('<certificates src="user" />');

      const manifest = {
        manifest: {
          application: [{ $: { 'android:name': '.MainApplication' } }],
        },
      };
      const updated = withLanNetworkSecurity.applyNetworkSecurityToManifest(manifest);
      expect(
        updated.manifest.application[0]?.$['android:networkSecurityConfig']
      ).toBe('@xml/network_security_config');
      expect(
        updated.manifest.application[0]?.$['android:usesCleartextTraffic']
      ).toBe('true');
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});

describe('Expo Config Plugin withAndroidReleaseSigning', () => {
  const sampleGradle = `android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
            storePassword 'android'
            keyAlias 'androiddebugkey'
            keyPassword 'android'
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            signingConfig signingConfigs.debug
            minifyEnabled false
        }
    }
}`;

  it('ergänzt signingConfigs.release und bedingte Release-Signatur, lässt debug unverändert', () => {
    const updated = withAndroidReleaseSigning.applyAndroidReleaseSigning(sampleGradle);

    expect(updated).toContain('release {');
    expect(updated).toContain("findProperty('BIBLIOLISA_UPLOAD_STORE_FILE')");
    expect(updated).toContain("storePassword findProperty('BIBLIOLISA_UPLOAD_STORE_PASSWORD')");
    expect(updated).toContain("keyAlias findProperty('BIBLIOLISA_UPLOAD_KEY_ALIAS')");
    expect(updated).toContain("keyPassword findProperty('BIBLIOLISA_UPLOAD_KEY_PASSWORD')");
    expect(updated).toContain(
      "signingConfig ((findProperty('BIBLIOLISA_UPLOAD_STORE_FILE') ?: '').toString().trim() ? signingConfigs.release : signingConfigs.debug)"
    );

    const debugBlockMatch = /buildTypes\s*\{\s*debug\s*\{([\s\S]*?)\}\s*release\s*\{/.exec(updated);
    expect(debugBlockMatch?.[1]).toContain('signingConfig signingConfigs.debug');
    expect(debugBlockMatch?.[1]).not.toContain('BIBLIOLISA_UPLOAD_STORE_FILE');
  });

  it('ist idempotent bei mehrfacher Anwendung', () => {
    const once = withAndroidReleaseSigning.applyAndroidReleaseSigning(sampleGradle);
    const twice = withAndroidReleaseSigning.applyAndroidReleaseSigning(once);
    expect(twice).toBe(once);
  });

  it('wirft einen klaren Fehler, wenn erwartete Gradle-Blöcke fehlen', () => {
    expect(() =>
      withAndroidReleaseSigning.applyAndroidReleaseSigning('android { buildTypes { release {} } }')
    ).toThrow(/signingConfigs\.debug/);

    expect(() =>
      withAndroidReleaseSigning.applyAndroidReleaseSigning(`android {
    signingConfigs {
        debug {
            storeFile file('debug.keystore')
        }
    }
    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
    }
}`)
    ).toThrow(/buildTypes\.release/);
  });
});
