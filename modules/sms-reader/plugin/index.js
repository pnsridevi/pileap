const { withAndroidManifest } = require('@expo/config-plugins');

/**
 * Expo config plugin for sms-reader.
 * Ensures READ_SMS and RECEIVE_SMS permissions are in AndroidManifest.xml.
 */
const withSmsReader = (config) => {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    const mainApplication = androidManifest.manifest;

    if (!mainApplication['uses-permission']) {
      mainApplication['uses-permission'] = [];
    }

    const permissions = [
      'android.permission.READ_SMS',
      'android.permission.RECEIVE_SMS',
    ];

    permissions.forEach((permission) => {
      const already = mainApplication['uses-permission'].some(
        (p) => p.$?.['android:name'] === permission
      );
      if (!already) {
        mainApplication['uses-permission'].push({
          $: { 'android:name': permission },
        });
      }
    });

    return config;
  });
};

module.exports = withSmsReader;