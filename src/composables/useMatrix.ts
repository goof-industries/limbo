import type { MatrixClient } from 'matrix-js-sdk';
import type { SavedHomeserver } from '~/types/Homeserver';
import * as sdk from 'matrix-js-sdk';

export const useMatrix = defineStore('matrix', () => {
  const savedHomeservers = useLocalStorage<Array<SavedHomeserver>>(
    'matrix/homeservers',
    [
      {
        name: 'matrix.org',
        url: 'https://matrix.org',
        description: 'The biggest public homeserver on Matrix.',
        featured: true,
      },
    ]
  );
  const homeserver = useLocalStorage<SavedHomeserver>(
    'matrix/homeserver',
    null,
    {
      serializer: {
        read(raw) {
          try {
            return JSON.parse(raw);
          } catch {
            return raw;
          }
        },
        write(value) {
          return JSON.stringify(value);
        },
      },
    }
  );

  // TODO: consider encrypting this
  const accessToken = useLocalStorage<string>('matrix/token', null);
  const deviceId = useLocalStorage<string>('matrix/deviceId', crypto.randomUUID())

  const client = ref<MatrixClient>();
  const loginFlows = ref<sdk.LoginFlow[]>();
  const status = ref<'idle' | 'connecting' | 'syncing' | 'ready'>('idle');

  async function initializeClient() {
    if (!homeserver.value)
      throw fail('Cannot create client if no homeserver is selected.');

    status.value = 'connecting';

    try {
      indexedDB.value = new sdk.IndexedDBStore({
        dbName: 'sync-store',
        indexedDB: global.indexedDB,
        localStorage: global.localStorage,
      });

      client.value = sdk.createClient({
        baseUrl: homeserver.value.url,
        accessToken: accessToken.value || undefined,
        deviceId: deviceId.value || undefined,
        verificationMethods: [VerificationMethod.Sas],
        timelineSupport: true,
        cryptoStore: new sdk.IndexedDBCryptoStore(
          global.indexedDB,
          'crypto-store'
        ),
        store: indexedDB.value,
      });
    } catch (e) {
      throw fail((e as Error).message);
    }

    try {
      const versions = await client.value.getVersions();
      if (!versions || !versions.versions.length)
        throw fail(
          `Homeserver (${homeserver.value.name}) does not seem to be a valid Matrix homeserver.`
        );
    } catch (e) {
      throw fail((e as Error).message);
    }

    if (accessToken.value) {
      // Try to login and skip manual authentication
      try {
        await startClient();
      } catch {}
    } else {
      status.value = 'idle';
    }

    function fail(message: string) {
      unsetCurrentHomeserver();
      return new Error(message);
    }
  }

  async function startClient() {
    if (!client.value) return;

    await registerGlobalEvents();

    const { user_id: userId } = await client.value.whoami();
    client.value.credentials.userId = userId;

    status.value = 'syncing';

    try {
      await client.value.initRustCrypto();
    } catch (e) {
      console.error('Failed to init crypto:', e);
    }

    await indexedDB.value!.startup();
    await client.value.startClient();
  }

  async function registerGlobalEvents() {
    if (!client.value) return;

    client.value.once(sdk.ClientEvent.Sync, (state) => {
      if (state === 'PREPARED') {
        status.value = 'ready';
      }
    });
  }

  async function fetchLoginFlows() {
    if (!client.value) return;
    const flows = await client.value.loginFlows();

    if (flows?.flows) {
      loginFlows.value = flows.flows;
    }

    return flows.flows;
  }

  async function verifyHomeserver(url: string): Promise<boolean> {
    try {
      const tempClient = sdk.createClient({ baseUrl: url });
      const versions = await tempClient.getVersions();
      if (!versions || !versions.versions.length) return false;
    } catch {
      return false;
    }

    return true;
  }

  /** Returns whether the current device is verified. */
  async function isVerified() {
    if (!client.value) return false;

    const crypto = client.value.getCrypto();
    if (!crypto) return false;

    const verificationStatus = await crypto.getDeviceVerificationStatus(
      client.value.getUserId()!,
      deviceId.value
    );

    return verificationStatus?.crossSigningVerified || false;
  }

  function addHomeserver(url: string, favorite = false) {
    savedHomeservers.value.push({
      name: new URL(url).host,
      url,
      favorite,
    });
  }

  function setCurrentHomeserver(url: string) {
    let _homeserver = savedHomeservers.value.find(
      (homeserver) => homeserver.url === url
    );

    if (!homeserver) {
      // Save the homeserver
      const host = new URL(url).host;
      const newHomeserver = { name: host, url };
      savedHomeservers.value.push(newHomeserver);
      _homeserver = newHomeserver;
    }

    homeserver.value = _homeserver!;
  }

  function unsetCurrentHomeserver() {
    homeserver.value = undefined;
    client.value = undefined;
    accessToken.value = null;
    status.value = 'idle';
  }

  return {
    client,
    accessToken,
    homeserver,
    savedHomeservers,
    loginFlows,
    status,
    fetchLoginFlows,
    addHomeserver,
    setCurrentHomeserver,
    unsetCurrentHomeserver,
    verifyHomeserver,
    initializeClient,
    isVerified,
  };
});

export * from './matrix/room';
export * from './matrix/user';
