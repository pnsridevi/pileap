// apps/mobile/app.config.js
//
// Sits NEXT TO app.json — app.json stays the main config and is not changed.
// Expo reads app.json first and passes it in here as `config`.
//
// For the "development" build profile only, this gives the app its own
// identity so it installs SIDE BY SIDE with the normal Pileap app:
//   name      Pileap      -> Pileap Dev
//   app ID    com.pileap.app -> com.pileap.app.dev
//   scheme    pileap      -> pileap-dev
//   colours   purple      -> red
// Every other profile (preview, production) gets app.json exactly as is.
//
// EAS_BUILD_PROFILE is set automatically by EAS during a cloud build.
// APP_VARIANT lets your PC (npx expo start) use the same values — add
// APP_VARIANT=development to the feature folder's .env.

const IS_DEV =
  process.env.EAS_BUILD_PROFILE === 'development' ||
  process.env.APP_VARIANT === 'development';

const DEV_COLOR = '#DC2626'; // red

module.exports = ({ config }) => {
  if (!IS_DEV) return config;

  return {
    ...config,
    name: 'Pileap Dev',
    scheme: 'pileap-dev',
    splash: { ...config.splash, backgroundColor: DEV_COLOR },
    ios: { ...config.ios, bundleIdentifier: 'com.pileap.app.dev' },
    android: {
      ...config.android,
      package: 'com.pileap.app.dev',
      adaptiveIcon: { ...config.android.adaptiveIcon, backgroundColor: DEV_COLOR },
    },
  };
};