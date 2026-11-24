import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { SyncStatusResponse } from '@bibliolisa/shared';
import { toast } from 'sonner';
import { api, errorMessage } from '@/api/client';
import { libraryKeys, syncKeys } from '@/hooks/useLibrary';

export { syncKeys };

export interface SyncFeedback {
  tone: 'success' | 'warning' | 'info' | 'error';
  message: string;
  checkedAt: string;
}

function formatBooksLabel(count: number): string {
  return count === 1 ? '1 Buch' : `${count} Bücher`;
}

function buildSyncFeedbackMessage(data: SyncStatusResponse): {
  tone: SyncFeedback['tone'];
  message: string;
} {
  const booksText = formatBooksLabel(data.totalBooks);
  switch (data.status) {
    case 'synced':
      return {
        tone: 'success',
        message: `Bibliothek aktualisiert (${booksText}) – mit Handy synchron.`,
      };
    case 'server_ahead': {
      const pendingText =
        data.pendingForMobileCount === 1
          ? '1 Änderung wartet noch auf Sync durch die Handy-App.'
          : `${data.pendingForMobileCount} Änderungen warten noch auf Sync durch die Handy-App.`;
      return {
        tone: 'warning',
        message: `Bibliothek aktualisiert (${booksText}) – ${pendingText}`,
      };
    }
    case 'never_synced':
      return {
        tone: 'warning',
        message: `Bibliothek aktualisiert (${booksText}) – verknüpfte Handy-App hat noch keinen vollständigen Sync abgeschlossen.`,
      };
    case 'no_mobile_device':
      return {
        tone: 'info',
        message: `Bibliothek aktualisiert (${booksText}) – aktuell kein Mobilgerät verknüpft.`,
      };
  }
}

export function useSyncStatus() {
  const queryClient = useQueryClient();
  const lastModifiedRef = useRef<string | null | undefined>(undefined);
  const [isManualSyncing, setIsManualSyncing] = useState(false);
  const [lastCheckedAt, setLastCheckedAt] = useState<string | null>(null);
  const [lastSyncFeedback, setLastSyncFeedback] = useState<SyncFeedback | null>(null);

  const query = useQuery({
    queryKey: syncKeys.status,
    queryFn: () => api.syncStatus(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    staleTime: 15_000,
  });

  useEffect(() => {
    if (!query.data) return;
    const nextModified = query.data.libraryLastModifiedAt;
    if (
      lastModifiedRef.current !== undefined &&
      lastModifiedRef.current !== nextModified
    ) {
      void queryClient.invalidateQueries({ queryKey: libraryKeys.all });
      void queryClient.invalidateQueries({ queryKey: libraryKeys.recommendations });
    }
    lastModifiedRef.current = nextModified;
  }, [query.data, queryClient]);

  const effectiveLastCheckedAt =
    lastCheckedAt ??
    (query.dataUpdatedAt > 0 ? new Date(query.dataUpdatedAt).toISOString() : null);

  const triggerManualSync = useCallback(async () => {
    setIsManualSyncing(true);
    try {
      const [, , , fresh] = await Promise.all([
        queryClient.invalidateQueries({ queryKey: libraryKeys.all }),
        queryClient.invalidateQueries({ queryKey: libraryKeys.recommendations }),
        queryClient.invalidateQueries({ queryKey: ['sessions'] }),
        query.refetch(),
      ]);

      const checkedAt = new Date().toISOString();
      setLastCheckedAt(checkedAt);

      if (fresh.error) {
        const message = errorMessage(fresh.error);
        setLastSyncFeedback({ tone: 'error', message, checkedAt });
        toast.error(`Synchronisation fehlgeschlagen: ${message}`);
        return null;
      }

      if (!fresh.data) {
        const message = 'Sync-Status konnte nicht vom Server abgerufen werden.';
        setLastSyncFeedback({ tone: 'error', message, checkedAt });
        toast.error(message);
        return null;
      }

      lastModifiedRef.current = fresh.data.libraryLastModifiedAt;
      const summary = buildSyncFeedbackMessage(fresh.data);
      setLastSyncFeedback({ ...summary, checkedAt });

      if (summary.tone === 'success') {
        toast.success(summary.message);
      } else if (summary.tone === 'warning') {
        toast.warning(summary.message);
      } else {
        toast.info(summary.message);
      }

      return fresh.data;
    } catch (error) {
      const checkedAt = new Date().toISOString();
      const message = errorMessage(error);
      setLastCheckedAt(checkedAt);
      setLastSyncFeedback({ tone: 'error', message, checkedAt });
      toast.error(`Synchronisation fehlgeschlagen: ${message}`);
      return null;
    } finally {
      setIsManualSyncing(false);
    }
  }, [query, queryClient]);

  return {
    ...query,
    lastCheckedAt: effectiveLastCheckedAt,
    lastSyncFeedback,
    isManualSyncing,
    triggerManualSync,
  };
}
