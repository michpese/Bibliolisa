import { Link, Route, Routes } from 'react-router-dom';
import { ProtectedRoute } from '@/auth/ProtectedRoute';
import { Layout } from '@/components/Layout';
import { Button } from '@/components/ui/button';
import { BackupPage } from '@/pages/BackupPage';
import { BookDetailPage } from '@/pages/BookDetailPage';
import { LibraryPage } from '@/pages/LibraryPage';
import { LoginPage } from '@/pages/LoginPage';
import { RecommendationsPage } from '@/pages/RecommendationsPage';
import { SettingsPage } from '@/pages/SettingsPage';

function NotFoundPage() {
  return (
    <div className="mx-auto max-w-md space-y-3 py-20 text-center">
      <h1 className="text-2xl font-bold">Seite nicht gefunden</h1>
      <p className="text-sm text-muted-foreground">Diese Adresse gibt es in Bibliolisa nicht.</p>
      <Button asChild>
        <Link to="/">Zur Bibliothek</Link>
      </Button>
    </div>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<ProtectedRoute />}>
        <Route element={<Layout />}>
          <Route index element={<LibraryPage />} />
          <Route path="books/:id" element={<BookDetailPage />} />
          <Route path="recommendations" element={<RecommendationsPage />} />
          <Route path="backup" element={<BackupPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
