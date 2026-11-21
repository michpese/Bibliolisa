import React from 'react';
import { ActivityIndicator, StyleSheet, Text, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import {
  DarkTheme,
  DefaultTheme,
  NavigationContainer,
} from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { Ionicons } from '@expo/vector-icons';
import { AppProvider, useAppContext } from './context/AppContext';
import type { MainTabParamList, RootStackParamList } from './navigation/types';
import { AddBookScreen } from './screens/AddBookScreen';
import { BookDetailScreen } from './screens/BookDetailScreen';
import { LibraryScreen } from './screens/LibraryScreen';
import { RecommendationsScreen } from './screens/RecommendationsScreen';
import { SettingsScreen } from './screens/SettingsScreen';
import { SyncProvider } from './sync/sync-context';
import { useAppTheme } from './theme';

const Tab = createBottomTabNavigator<MainTabParamList>();
const Stack = createNativeStackNavigator<RootStackParamList>();

function MainTabs() {
  const theme = useAppTheme();

  return (
    <Tab.Navigator
      screenOptions={({ route }) => ({
        headerShown: false,
        tabBarActiveTintColor: theme.primary,
        tabBarInactiveTintColor: theme.textMuted,
        tabBarStyle: {
          backgroundColor: theme.card,
          borderTopColor: theme.border,
        },
        tabBarIcon: ({ color, size, focused }) => {
          let iconName: keyof typeof Ionicons.glyphMap = 'book-outline';
          switch (route.name) {
            case 'LibraryTab':
              iconName = focused ? 'library' : 'library-outline';
              break;
            case 'AddBookTab':
              iconName = focused ? 'add-circle' : 'add-circle-outline';
              break;
            case 'RecommendationsTab':
              iconName = focused ? 'sparkles' : 'sparkles-outline';
              break;
            case 'SettingsTab':
              iconName = focused ? 'settings' : 'settings-outline';
              break;
          }
          return <Ionicons name={iconName} size={size} color={color} />;
        },
      })}
    >
      <Tab.Screen
        name="LibraryTab"
        component={LibraryScreen}
        options={{ title: 'Bibliothek' }}
      />
      <Tab.Screen
        name="AddBookTab"
        component={AddBookScreen}
        options={{ title: 'Hinzufügen' }}
      />
      <Tab.Screen
        name="RecommendationsTab"
        component={RecommendationsScreen}
        options={{ title: 'Empfehlungen' }}
      />
      <Tab.Screen
        name="SettingsTab"
        component={SettingsScreen}
        options={{ title: 'Einstellungen' }}
      />
    </Tab.Navigator>
  );
}

function AppShell() {
  const theme = useAppTheme();
  const { ready, initError } = useAppContext();

  if (initError) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <Text style={[styles.errorText, { color: theme.danger }]}>
          {initError}
        </Text>
      </View>
    );
  }

  if (!ready) {
    return (
      <View style={[styles.centered, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.primary} />
        <Text style={[styles.loadingText, { color: theme.textMuted }]}>
          Lokale Bibliothek wird geöffnet…
        </Text>
      </View>
    );
  }

  const navTheme = theme.isDark
    ? {
        ...DarkTheme,
        colors: {
          ...DarkTheme.colors,
          background: theme.background,
          card: theme.card,
          text: theme.text,
          border: theme.border,
          primary: theme.primary,
        },
      }
    : {
        ...DefaultTheme,
        colors: {
          ...DefaultTheme.colors,
          background: theme.background,
          card: theme.card,
          text: theme.text,
          border: theme.border,
          primary: theme.primary,
        },
      };

  return (
    <NavigationContainer theme={navTheme}>
      <StatusBar style={theme.isDark ? 'light' : 'dark'} />
      <Stack.Navigator>
        <Stack.Screen
          name="MainTabs"
          component={MainTabs}
          options={{ headerShown: false }}
        />
        <Stack.Screen
          name="BookDetail"
          component={BookDetailScreen}
          options={{
            title: 'Buchdetails',
            headerStyle: { backgroundColor: theme.card },
            headerTintColor: theme.text,
          }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}

export default function App() {
  return (
    <SafeAreaProvider>
      <AppProvider>
        <SyncProvider>
          <AppShell />
        </SyncProvider>
      </AppProvider>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
    gap: 12,
  },
  loadingText: {
    fontSize: 14,
  },
  errorText: {
    fontSize: 15,
    fontWeight: '600',
    textAlign: 'center',
  },
});
