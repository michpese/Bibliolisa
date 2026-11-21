import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type {
  LibraryEntry,
  ReadingStatus,
  UpdateLibraryEntry,
} from '@bibliolisa/shared';
import { api, type LibraryFilters } from '@/api/client';

export const libraryKeys = {
  all: ['library'] as const,
  list: (filters: LibraryFilters) => ['library', 'list', filters] as const,
  entry: (id: string) => ['library', 'entry', id] as const,
  facets: ['library', 'facets'] as const,
  recommendations: ['recommendations'] as const,
};

const PAGE_SIZE = 200;
const MAX_PAGES = 25;

/** Lädt alle Seiten der (serverseitig gefilterten & sortierten) Bibliothek. */
export function useLibraryAll(filters: LibraryFilters, options: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: libraryKeys.list(filters),
    placeholderData: keepPreviousData,
    enabled: options.enabled ?? true,
    queryFn: async ({ signal }) => {
      const first = await api.libraryPage(filters, 1, PAGE_SIZE, signal);
      const items: LibraryEntry[] = [...first.items];
      const lastPage = Math.min(first.totalPages, MAX_PAGES);
      for (let page = 2; page <= lastPage; page += 1) {
        const next = await api.libraryPage(filters, page, PAGE_SIZE, signal);
        items.push(...next.items);
      }
      return { items, total: first.total };
    },
  });
}

export function useFacets() {
  return useQuery({
    queryKey: libraryKeys.facets,
    queryFn: () => api.facets(),
  });
}

export function useEntry(id: string | undefined) {
  return useQuery({
    queryKey: libraryKeys.entry(id ?? ''),
    queryFn: () => api.entry(id as string),
    enabled: Boolean(id),
  });
}

/** Ersetzt einen Eintrag in allen gecachten Listen und im Detail-Cache. */
function patchCachedEntry(
  client: QueryClient,
  id: string,
  patch: (entry: LibraryEntry) => LibraryEntry
): void {
  client.setQueriesData<{ items: LibraryEntry[]; total: number }>(
    { queryKey: ['library', 'list'] },
    (old) =>
      old
        ? {
            ...old,
            items: old.items.map((item) => (item.id === id ? patch(item) : item)),
          }
        : old
  );
  client.setQueryData<LibraryEntry>(libraryKeys.entry(id), (old) =>
    old ? patch(old) : old
  );
}

/** Leitet Zeitstempel für Statuswechsel ab (Server setzt diese nicht automatisch). */
export function statusTransitionPatch(
  entry: Pick<LibraryEntry, 'startedAt' | 'finishedAt'>,
  status: ReadingStatus
): Pick<UpdateLibraryEntry, 'status' | 'startedAt' | 'finishedAt'> {
  const now = new Date().toISOString();
  switch (status) {
    case 'unread':
      return { status, startedAt: null, finishedAt: null };
    case 'reading':
      return { status, startedAt: entry.startedAt ?? now, finishedAt: null };
    case 'read':
      return {
        status,
        startedAt: entry.startedAt ?? now,
        finishedAt: now,
      };
    case 'abandoned':
      return { status, startedAt: entry.startedAt ?? now, finishedAt: null };
  }
}

/** Optimistische Updates für schnelle Ein-Klick-Änderungen (Status, Rating, Notizen …). */
export function useUpdateEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateLibraryEntry }) =>
      api.updateEntry(id, patch),
    onMutate: async ({ id, patch }) => {
      await client.cancelQueries({ queryKey: libraryKeys.all });
      const previousLists = client.getQueriesData<{
        items: LibraryEntry[];
        total: number;
      }>({ queryKey: ['library', 'list'] });
      const previousEntry = client.getQueryData<LibraryEntry>(libraryKeys.entry(id));

      patchCachedEntry(client, id, (entry) => ({
        ...entry,
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.startedAt !== undefined ? { startedAt: patch.startedAt } : {}),
        ...(patch.finishedAt !== undefined ? { finishedAt: patch.finishedAt } : {}),
      }));

      return { previousLists, previousEntry, id };
    },
    onError: (_error, _vars, context) => {
      if (!context) return;
      for (const [key, data] of context.previousLists) {
        client.setQueryData(key, data);
      }
      if (context.previousEntry) {
        client.setQueryData(libraryKeys.entry(context.id), context.previousEntry);
      }
    },
    onSuccess: (updated) => {
      patchCachedEntry(client, updated.id, () => updated);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: libraryKeys.facets });
      void client.invalidateQueries({ queryKey: libraryKeys.recommendations });
    },
  });
}

export function useDeleteEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.deleteEntry(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: libraryKeys.all });
      void client.invalidateQueries({ queryKey: libraryKeys.recommendations });
    },
  });
}

export function useRestoreEntry() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.restoreEntry(id),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: libraryKeys.all });
      void client.invalidateQueries({ queryKey: libraryKeys.recommendations });
    },
  });
}

export function useInvalidateLibrary() {
  const client = useQueryClient();
  return () => {
    void client.invalidateQueries({ queryKey: libraryKeys.all });
    void client.invalidateQueries({ queryKey: libraryKeys.recommendations });
  };
}
