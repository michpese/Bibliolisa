import type { NavigatorScreenParams } from '@react-navigation/native';

export type MainTabParamList = {
  LibraryTab: undefined;
  AddBookTab: { initialIsbn?: string } | undefined;
  RecommendationsTab: undefined;
  SettingsTab: undefined;
};

export type RootStackParamList = {
  MainTabs: NavigatorScreenParams<MainTabParamList>;
  BookDetail: { userBookId: string };
};
