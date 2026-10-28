/**
 * apps/mobile/index.js — app entry point (set as "main" in package.json).
 *
 * Why this file exists: the background sync task must be defined
 * (TaskManager.defineTask) every time the app's JavaScript starts —
 * including when Android wakes the app in the background with no screen
 * drawn. Previously the task was only defined inside app/(app)/_layout.tsx,
 * which Expo Router only loads when it draws a screen, so background
 * starts found no task to run.
 *
 * Order matters: define the task first, then start Expo Router as before.
 */
import './src/lib/services/backgroundSync';
import 'expo-router/entry';
