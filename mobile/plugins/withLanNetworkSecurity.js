const fs = require('node:fs');
const path = require('node:path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
} = require('expo/config-plugins');

const NETWORK_SECURITY_CONFIG_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
    <!-- Erlaubt frei konfigurierbare http:// LAN-URLs sowie benutzerinstallierte CA-Zertifikate für https:// im LAN -->
    <base-config cleartextTrafficPermitted="true">
        <trust-anchors>
            <certificates src="system" />
            <certificates src="user" />
        </trust-anchors>
    </base-config>
</network-security-config>
`;

function applyNetworkSecurityToManifest(androidManifest) {
  const mainApplication =
    AndroidConfig.Manifest.getMainApplicationOrThrow(androidManifest);
  mainApplication.$['android:networkSecurityConfig'] =
    '@xml/network_security_config';
  mainApplication.$['android:usesCleartextTraffic'] = 'true';
  return androidManifest;
}

function writeNetworkSecurityConfigFile(platformProjectRoot) {
  const xmlDir = path.join(platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
  fs.mkdirSync(xmlDir, { recursive: true });
  const targetPath = path.join(xmlDir, 'network_security_config.xml');
  fs.writeFileSync(targetPath, NETWORK_SECURITY_CONFIG_XML, 'utf8');
  return targetPath;
}

function withLanNetworkSecurity(config) {
  let updatedConfig = withDangerousMod(config, [
    'android',
    async (modConfig) => {
      writeNetworkSecurityConfigFile(modConfig.modRequest.platformProjectRoot);
      return modConfig;
    },
  ]);

  updatedConfig = withAndroidManifest(updatedConfig, async (modConfig) => {
    modConfig.modResults = applyNetworkSecurityToManifest(modConfig.modResults);
    return modConfig;
  });

  return updatedConfig;
}

module.exports = withLanNetworkSecurity;
module.exports.NETWORK_SECURITY_CONFIG_XML = NETWORK_SECURITY_CONFIG_XML;
module.exports.applyNetworkSecurityToManifest = applyNetworkSecurityToManifest;
module.exports.writeNetworkSecurityConfigFile = writeNetworkSecurityConfigFile;
