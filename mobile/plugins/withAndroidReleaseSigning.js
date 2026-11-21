const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING_CONFIGS_PATTERN =
  /(signingConfigs\s*\{\s*debug\s*\{[\s\S]*?\r?\n\s*\})(\r?\n\s*\})/;
const RELEASE_SIGNING_CONFIG_ASSIGNMENT_PATTERN =
  /(buildTypes\s*\{[\s\S]*?\brelease\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/;

const RELEASE_SIGNING_CONFIG_BLOCK = `        release {
            def releaseStoreFile = (findProperty('BIBLIOLISA_UPLOAD_STORE_FILE') ?: '').toString().trim()
            if (releaseStoreFile) {
                storeFile file(releaseStoreFile)
                storePassword findProperty('BIBLIOLISA_UPLOAD_STORE_PASSWORD')
                keyAlias findProperty('BIBLIOLISA_UPLOAD_KEY_ALIAS')
                keyPassword findProperty('BIBLIOLISA_UPLOAD_KEY_PASSWORD')
            }
        }`;

const RELEASE_SIGNING_CONFIG_EXPRESSION =
  "signingConfig ((findProperty('BIBLIOLISA_UPLOAD_STORE_FILE') ?: '').toString().trim() ? signingConfigs.release : signingConfigs.debug)";

/**
 * Configures an optional release signingConfig in android/app/build.gradle
 * controlled by Gradle properties (falling back to debug signing when unset).
 */
function applyAndroidReleaseSigning(contents) {
  if (contents.includes('BIBLIOLISA_UPLOAD_STORE_FILE')) {
    return contents;
  }

  if (!SIGNING_CONFIGS_PATTERN.test(contents)) {
    throw new Error(
      'withAndroidReleaseSigning: Erwarteter signingConfigs.debug-Block in android/app/build.gradle nicht gefunden.'
    );
  }

  let updated = contents.replace(
    SIGNING_CONFIGS_PATTERN,
    `$1\n${RELEASE_SIGNING_CONFIG_BLOCK}$2`
  );

  if (!RELEASE_SIGNING_CONFIG_ASSIGNMENT_PATTERN.test(updated)) {
    throw new Error(
      'withAndroidReleaseSigning: Erwartete signingConfig-Zuweisung in buildTypes.release nicht gefunden.'
    );
  }

  updated = updated.replace(
    RELEASE_SIGNING_CONFIG_ASSIGNMENT_PATTERN,
    `$1${RELEASE_SIGNING_CONFIG_EXPRESSION}`
  );

  return updated;
}

function withAndroidReleaseSigning(config) {
  return withAppBuildGradle(config, (modConfig) => {
    if (modConfig.modResults.language && modConfig.modResults.language !== 'groovy') {
      throw new Error(
        `withAndroidReleaseSigning: Nur Groovy app/build.gradle wird unterstützt (gefunden: ${modConfig.modResults.language}).`
      );
    }

    modConfig.modResults.contents = applyAndroidReleaseSigning(
      modConfig.modResults.contents
    );
    return modConfig;
  });
}

module.exports = withAndroidReleaseSigning;
module.exports.applyAndroidReleaseSigning = applyAndroidReleaseSigning;
