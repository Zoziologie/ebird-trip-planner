import { initializeApp } from 'firebase/app';
import {
  getAuth,
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  setPersistence,
  browserLocalPersistence,
  connectAuthEmulator,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  collection,
  query,
  where,
  onSnapshot,
  getDoc,
  getDocs,
  runTransaction,
  serverTimestamp,
  Timestamp,
  setDoc,
  updateDoc,
  connectFirestoreEmulator,
} from 'firebase/firestore';
import {
  getStorage,
  ref as storageRef,
  uploadBytesResumable,
  getBlob,
  deleteObject,
  connectStorageEmulator,
} from 'firebase/storage';
import {
  cloudConfig,
  cloudConfigured,
  cloudUser,
  cloudReady,
  cloudLibrary,
  cloudError,
  cloudLimitBytes,
  cloudAllowance,
  cloudRequest,
} from '../state/cloudTrips';

let services;
let subscriptions = [];
let sharedSubscriptions = [];

export const initCloud = async () => {
  if (!cloudConfigured || services) return services;
  const app = initializeApp(cloudConfig, 'trip-cloud');
  const auth = getAuth(app);
  const database = getFirestore(app);
  const storage = getStorage(app);
  // Fail in seconds, not the 10-minute default, when a request is blocked or offline.
  storage.maxOperationRetryTime = 20000;
  storage.maxDownloadRetryTime = 20000;
  storage.maxUploadRetryTime = 60000;
  services = { auth, database, storage };
  if (
    (import.meta.env.DEV || cloudConfig.projectId.startsWith('demo-')) &&
    import.meta.env.VITE_FIREBASE_EMULATORS === 'true'
  ) {
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(database, '127.0.0.1', 8080);
    connectStorageEmulator(storage, '127.0.0.1', 9199);
  }
  await setPersistence(auth, browserLocalPersistence);
  onAuthStateChanged(auth, (user) => {
    subscriptions.forEach((stop) => stop());
    sharedSubscriptions.forEach((stop) => stop());
    subscriptions = [];
    sharedSubscriptions = [];
    cloudUser.value = user;
    cloudReady.value = true;
    cloudLibrary.value = [];
    cloudError.value = '';
    cloudAllowance.value = 1;
    cloudRequest.value = null;
    if (!user) return;
    subscriptions.push(
      onSnapshot(
        doc(database, 'cloudAccounts', user.uid),
        (snapshot) => {
          cloudAllowance.value = snapshot.data()?.tripSlots || 1;
        },
        (error) => {
          cloudError.value = error.message;
        },
      ),
    );
    subscriptions.push(
      onSnapshot(
        doc(database, 'capacityRequests', user.uid),
        (snapshot) => {
          cloudRequest.value = snapshot.data() || null;
        },
        (error) => {
          cloudError.value = error.message;
        },
      ),
    );
    const owned = new Map();
    const shared = new Map();
    const publish = () => {
      cloudLibrary.value = [...owned.values(), ...shared.values()].sort(
        (a, b) => (b.updatedAt?.toMillis() || 0) - (a.updatedAt?.toMillis() || 0),
      );
    };
    const failed = (error) => {
      cloudError.value = error.message;
    };
    subscriptions.push(
      onSnapshot(
        query(collection(database, 'cloudTrips'), where('ownerUid', '==', user.uid)),
        (snapshot) => {
          owned.clear();
          snapshot.docs.forEach((item) =>
            owned.set(item.id, { id: item.id, ...item.data(), owned: true }),
          );
          publish();
        },
        failed,
      ),
    );
    subscriptions.push(
      onSnapshot(
        query(
          collection(database, 'tripAccess'),
          where('editorEmails', 'array-contains', user.email.toLowerCase()),
        ),
        (snapshot) => {
          sharedSubscriptions.forEach((stop) => stop());
          sharedSubscriptions = [];
          shared.clear();
          publish();
          snapshot.docs.forEach((item) => {
            sharedSubscriptions.push(
              onSnapshot(
                doc(database, 'cloudTrips', item.id),
                (trip) => {
                  if (trip.exists())
                    shared.set(trip.id, { id: trip.id, ...trip.data(), owned: false });
                  else shared.delete(trip.id);
                  publish();
                },
                failed,
              ),
            );
          });
        },
        failed,
      ),
    );
  });
  return services;
};

export const signInCloud = async () => {
  const { auth } = await initCloud();
  await signInWithPopup(auth, new GoogleAuthProvider());
};
export const signOutCloud = async () => {
  await signOut((await initCloud()).auth);
};
export const getCloudTrip = async (id) => {
  const { database } = await initCloud();
  const snapshot = await getDoc(doc(database, 'cloudTrips', id));
  if (!snapshot.exists() || !snapshot.data().revision)
    throw new Error('This cloud trip is unavailable or has not finished saving.');
  return { id, ...snapshot.data() };
};
export const getCloudAccess = async (id) => {
  const { database } = await initCloud();
  return (await getDoc(doc(database, 'tripAccess', id))).data();
};
export const downloadCloudTrip = async (trip) => {
  const { storage } = await initCloud();
  return getBlob(
    storageRef(storage, `trips/${trip.id}/${trip.revision}.ebirdtrip`),
    cloudLimitBytes,
  );
};

// Reserve one upload, write an immutable archive, then atomically publish its revision.
// Readers continue to use the previous file until the upload finishes.
export const saveCloudTrip = async (blob, details, binding = null, onProgress = () => {}) => {
  if (blob.size > cloudLimitBytes)
    throw new Error(
      'This compressed trip exceeds the 50 MB cloud limit. Export it locally instead.',
    );
  const { auth, database, storage } = await initCloud();
  const user = auth.currentUser;
  if (!user) throw new Error('Sign in with Google to save a cloud trip.');
  let id = binding?.id;
  if (!id) {
    const account = await getDoc(doc(database, 'cloudAccounts', user.uid));
    const slots = account.data()?.tripSlots || 1;
    const owned = await getDocs(
      query(collection(database, 'cloudTrips'), where('ownerUid', '==', user.uid)),
    );
    id = Array.from({ length: slots }, (_, slot) => slot)
      .map((slot) => `${user.uid}_${slot}`)
      .find((slot) => {
        const existing = owned.docs.find((item) => item.id === slot)?.data();
        return (
          !existing ||
          (!existing.revision &&
            (!existing.pending || existing.pending.expiresAt.toMillis() <= Date.now()))
        );
      });
    if (!id)
      throw new Error(
        'Your cloud allowance is full. Update or delete an existing cloud trip, or request more capacity.',
      );
  }
  const tripRef = doc(database, 'cloudTrips', id);
  const revision = crypto.randomUUID();
  const pending = {
    revision,
    uid: user.uid,
    expiresAt: Timestamp.fromMillis(Date.now() + 10 * 60 * 1000),
  };
  const previous = await runTransaction(database, async (transaction) => {
    const snapshot = await transaction.get(tripRef);
    const current = snapshot.data();
    if (current && current.revision !== (binding?.revision || ''))
      throw new Error(
        'The cloud trip changed. Reload from cloud before saving, or save your own copy.',
      );
    if (current?.pending && current.pending.expiresAt.toMillis() > Date.now())
      throw new Error('Another save is in progress. Wait for it to finish and try again.');
    if (current) transaction.update(tripRef, { pending });
    else {
      transaction.set(doc(database, 'tripAccess', id), {
        ownerUid: user.uid,
        ownerEmail: user.email.toLowerCase(),
        editorEmails: [],
      });
      transaction.set(tripRef, {
        ownerUid: user.uid,
        name: details.name,
        public: false,
        revision: '',
        size: 0,
        localUpdatedAt: 0,
        visitCount: 0,
        updatedAt: serverTimestamp(),
        lastActiveAt: serverTimestamp(),
        pending,
      });
    }
    return current;
  });
  const archiveRef = storageRef(storage, `trips/${id}/${revision}.ebirdtrip`);
  try {
    if (previous?.pending)
      await deleteObject(
        storageRef(storage, `trips/${id}/${previous.pending.revision}.ebirdtrip`),
      ).catch((error) => {
        if (error.code !== 'storage/object-not-found') throw error;
      });
    const upload = uploadBytesResumable(archiveRef, blob, { contentType: 'application/gzip' });
    await new Promise((resolve, reject) =>
      upload.on(
        'state_changed',
        (snapshot) => onProgress(snapshot.bytesTransferred / snapshot.totalBytes),
        reject,
        resolve,
      ),
    );
    await runTransaction(database, async (transaction) => {
      const current = (await transaction.get(tripRef)).data();
      if (current.pending?.revision !== revision)
        throw new Error(
          'The save reservation expired. Your previous cloud trip is unchanged; try again.',
        );
      transaction.update(tripRef, {
        ...details,
        revision,
        size: blob.size,
        updatedAt: serverTimestamp(),
        lastActiveAt: serverTimestamp(),
        pending: null,
      });
    });
  } catch (error) {
    await runTransaction(database, async (transaction) => {
      const current = (await transaction.get(tripRef)).data();
      if (current?.pending?.revision === revision) transaction.update(tripRef, { pending: null });
    }).catch(() => {});
    await deleteObject(archiveRef).catch(() => {});
    throw error;
  }
  if (previous?.revision)
    await deleteObject(storageRef(storage, `trips/${id}/${previous.revision}.ebirdtrip`)).catch(
      (error) => {
        cloudError.value = `Saved, but an older file could not be cleaned up: ${error.message}`;
      },
    );
  return getCloudTrip(id);
};

export const setCloudSharing = async (id, isPublic, editorEmails) => {
  const { database } = await initCloud();
  const emails = [
    ...new Set(editorEmails.map((email) => email.trim().toLowerCase()).filter(Boolean)),
  ];
  await runTransaction(database, async (transaction) => {
    await transaction.get(doc(database, 'cloudTrips', id));
    transaction.update(doc(database, 'tripAccess', id), { editorEmails: emails });
    transaction.update(doc(database, 'cloudTrips', id), { public: isPublic });
  });
};

export const deleteCloudTrip = async (binding) => {
  const { database, storage } = await initCloud();
  const tripRef = doc(database, 'cloudTrips', binding.id);
  const previous = await runTransaction(database, async (transaction) => {
    const current = (await transaction.get(tripRef)).data();
    if (current.revision && current.revision !== binding.revision)
      throw new Error('The cloud trip changed. Reload before deleting it.');
    if (current.pending?.expiresAt.toMillis() > Date.now())
      throw new Error('A save is in progress. Wait before deleting this cloud trip.');
    transaction.update(tripRef, { revision: '', size: 0, public: false, pending: null });
    return current;
  });
  for (const revision of [binding.revision, previous.pending?.revision].filter(Boolean)) {
    await deleteObject(storageRef(storage, `trips/${binding.id}/${revision}.ebirdtrip`)).catch(
      (error) => {
        if (error.code !== 'storage/object-not-found') throw error;
      },
    );
  }
  await runTransaction(database, async (transaction) => {
    const current = (await transaction.get(tripRef)).data();
    if (current.revision || current.pending)
      throw new Error(
        'This cloud slot was reused. Reload its current trip before making more changes.',
      );
    transaction.delete(doc(database, 'workspaces', binding.id));
    transaction.delete(tripRef);
    transaction.delete(doc(database, 'tripAccess', binding.id));
  });
};

export const recordCloudActivity = async (id) => {
  const { database } = await initCloud();
  await updateDoc(doc(database, 'cloudTrips', id), { lastActiveAt: serverTimestamp() });
};
export const requestCloudCapacity = async (tripSlots, reason) => {
  const { auth, database } = await initCloud();
  await setDoc(doc(database, 'capacityRequests', auth.currentUser.uid), {
    email: auth.currentUser.email.toLowerCase(),
    tripSlots,
    reason: reason.trim(),
    status: 'pending',
    updatedAt: serverTimestamp(),
  });
};
