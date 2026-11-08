import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { buildWorkspacePlan, validatePlanSize } from '../../src/utils/workspacePlan.js';
import {
  initializeTestEnvironment,
  assertSucceeds,
  assertFails,
} from '@firebase/rules-unit-testing';
import {
  doc,
  setDoc,
  getDoc,
  updateDoc,
  collection,
  query,
  where,
  getDocs,
  writeBatch,
  Timestamp,
  serverTimestamp,
} from 'firebase/firestore';
import { ref, uploadBytes, getBytes, deleteObject } from 'firebase/storage';
const env = await initializeTestEnvironment({
  projectId: 'demo-ebird-trip-planner',
  firestore: { rules: await readFile('firestore.rules', 'utf8') },
  storage: { rules: await readFile('storage.rules', 'utf8') },
});
const google = (uid, email = `${uid}@example.com`) =>
  env.authenticatedContext(uid, {
    email,
    email_verified: true,
    firebase: { sign_in_provider: 'google.com' },
  });
const owner = google('owner');
const editor = google('editor');
const stranger = google('stranger');
const anonymous = env.unauthenticatedContext();
const id = 'owner_0';
const pending = (revision) => ({
  revision,
  uid: 'owner',
  expiresAt: Timestamp.fromMillis(Date.now() + 600000),
});
const trip = {
  ownerUid: 'owner',
  name: 'Test trip',
  public: false,
  revision: '',
  size: 0,
  localUpdatedAt: 0,
  visitCount: 0,
  updatedAt: serverTimestamp(),
  lastActiveAt: serverTimestamp(),
  pending: pending('first'),
};
try {
  const batch = writeBatch(owner.firestore());
  batch.set(doc(owner.firestore(), 'tripAccess', id), {
    ownerUid: 'owner',
    ownerEmail: 'owner@example.com',
    editorEmails: [],
  });
  batch.set(doc(owner.firestore(), 'cloudTrips', id), trip);
  await assertSucceeds(batch.commit());
  await assertFails(getDoc(doc(stranger.firestore(), 'cloudTrips', id)));
  await assertFails(getDoc(doc(anonymous.firestore(), 'cloudTrips', id)));
  await assertSucceeds(
    getDocs(query(collection(owner.firestore(), 'cloudTrips'), where('ownerUid', '==', 'owner'))),
  );
  await assertFails(setDoc(doc(owner.firestore(), 'cloudTrips', 'owner_1'), trip));
  await assertFails(setDoc(doc(owner.firestore(), 'cloudAccounts', 'owner'), { tripSlots: 10 }));
  await assertSucceeds(
    setDoc(doc(owner.firestore(), 'capacityRequests', 'owner'), {
      email: 'owner@example.com',
      tripSlots: 3,
      reason: 'More destinations',
      status: 'pending',
      updatedAt: serverTimestamp(),
    }),
  );
  await assertFails(
    updateDoc(doc(owner.firestore(), 'capacityRequests', 'owner'), { status: 'approved' }),
  );
  await assertFails(getDoc(doc(stranger.firestore(), 'capacityRequests', 'owner')));
  await env.withSecurityRulesDisabled(async (admin) =>
    setDoc(doc(admin.firestore(), 'cloudAccounts', 'owner'), { tripSlots: 3 }),
  );
  const extra = writeBatch(owner.firestore());
  extra.set(doc(owner.firestore(), 'tripAccess', 'owner_2'), {
    ownerUid: 'owner',
    ownerEmail: 'owner@example.com',
    editorEmails: [],
  });
  extra.set(doc(owner.firestore(), 'cloudTrips', 'owner_2'), trip);
  await assertSucceeds(extra.commit());
  await assertFails(setDoc(doc(owner.firestore(), 'cloudTrips', 'owner_3'), trip));
  const free = writeBatch(stranger.firestore());
  free.set(doc(stranger.firestore(), 'tripAccess', 'stranger_0'), {
    ownerUid: 'stranger',
    ownerEmail: 'stranger@example.com',
    editorEmails: [],
  });
  free.set(doc(stranger.firestore(), 'cloudTrips', 'stranger_0'), {
    ...trip,
    ownerUid: 'stranger',
    pending: { ...pending('x'), uid: 'stranger' },
  });
  await assertSucceeds(free.commit());
  await assertFails(
    updateDoc(doc(anonymous.firestore(), 'cloudTrips', id), { lastActiveAt: serverTimestamp() }),
  );
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), { lastActiveAt: serverTimestamp() }),
  );
  await assertSucceeds(
    uploadBytes(ref(owner.storage(), `trips/${id}/first.ebirdtrip`), new Uint8Array([1, 2, 3]), {
      contentType: 'application/gzip',
    }),
  );
  await assertFails(
    uploadBytes(ref(owner.storage(), `trips/${id}/other.ebirdtrip`), new Uint8Array([1]), {
      contentType: 'application/gzip',
    }),
  );
  await assertFails(
    uploadBytes(ref(stranger.storage(), `trips/${id}/first.ebirdtrip`), new Uint8Array([1]), {
      contentType: 'application/gzip',
    }),
  );
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), {
      revision: 'first',
      size: 3,
      pending: null,
      updatedAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
    }),
  );
  await assertSucceeds(getBytes(ref(owner.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertFails(deleteObject(ref(owner.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertFails(getBytes(ref(anonymous.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), 'tripAccess', id), { editorEmails: ['editor@example.com'] }),
  );
  await assertSucceeds(getDoc(doc(editor.firestore(), 'cloudTrips', id)));
  await assertSucceeds(
    getDocs(
      query(
        collection(editor.firestore(), 'tripAccess'),
        where('editorEmails', 'array-contains', 'editor@example.com'),
      ),
    ),
  );
  await assertSucceeds(getBytes(ref(editor.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertFails(updateDoc(doc(editor.firestore(), 'cloudTrips', id), { public: true }));
  await assertFails(
    updateDoc(doc(editor.firestore(), 'tripAccess', id), {
      editorEmails: ['stranger@example.com'],
    }),
  );
  await assertSucceeds(updateDoc(doc(owner.firestore(), 'cloudTrips', id), { public: true }));
  await assertSucceeds(getDoc(doc(anonymous.firestore(), 'cloudTrips', id)));
  await assertSucceeds(getBytes(ref(anonymous.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertFails(getDoc(doc(anonymous.firestore(), 'tripAccess', id)));
  await assertFails(updateDoc(doc(anonymous.firestore(), 'cloudTrips', id), { name: 'Attack' }));
  await assertSucceeds(updateDoc(doc(owner.firestore(), 'cloudTrips', id), { public: false }));
  await assertFails(getBytes(ref(anonymous.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), { pending: pending('second') }),
  );
  await assertFails(
    uploadBytes(
      ref(owner.storage(), `trips/${id}/second.ebirdtrip`),
      new Uint8Array(50 * 1024 * 1024 + 1),
      { contentType: 'application/gzip' },
    ),
  );
  await assertSucceeds(
    uploadBytes(
      ref(owner.storage(), `trips/${id}/second.ebirdtrip`),
      new Uint8Array(50 * 1024 * 1024),
      { contentType: 'application/gzip' },
    ),
  );
  await assertFails(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), {
      revision: 'invented',
      pending: null,
      updatedAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
    }),
  );
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), {
      revision: 'second',
      size: 50 * 1024 * 1024,
      pending: null,
      updatedAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
    }),
  );
  await assertFails(getBytes(ref(owner.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertSucceeds(deleteObject(ref(owner.storage(), `trips/${id}/first.ebirdtrip`)));
  await assertSucceeds(
    updateDoc(doc(editor.firestore(), 'cloudTrips', id), {
      pending: { ...pending('editor-save'), uid: 'editor' },
    }),
  );
  await assertSucceeds(
    uploadBytes(ref(editor.storage(), `trips/${id}/editor-save.ebirdtrip`), new Uint8Array([5]), {
      contentType: 'application/gzip',
    }),
  );
  await assertSucceeds(
    updateDoc(doc(editor.firestore(), 'cloudTrips', id), {
      name: 'Edited shared trip',
      revision: 'editor-save',
      size: 1,
      pending: null,
      updatedAt: serverTimestamp(),
      lastActiveAt: serverTimestamp(),
    }),
  );
  await assertSucceeds(getBytes(ref(owner.storage(), `trips/${id}/editor-save.ebirdtrip`)));
  const workspaceRef = (context) => doc(context.firestore(), 'workspaces', id);
  const plan = { version: 1, name: 'Oman', timeZone: '', reportId: '468402', stops: [] };
  const workspace = {
    datasetRevision: 'editor-save',
    revision: 'plan-1',
    commitId: 'plan-1',
    generation: 1,
    plan,
    updatedAt: serverTimestamp(),
  };
  await assertFails(setDoc(workspaceRef(editor), workspace));
  await assertSucceeds(setDoc(workspaceRef(owner), workspace));
  await assertSucceeds(getDoc(workspaceRef(editor)));
  await assertFails(getDoc(workspaceRef(stranger)));
  await assertFails(getDoc(workspaceRef(anonymous)));
  await assertSucceeds(updateDoc(doc(owner.firestore(), 'cloudTrips', id), { public: true }));
  await assertSucceeds(getDoc(workspaceRef(anonymous)));
  // Migrating to the workspace immediately closes anonymous archive downloads.
  await assertFails(getBytes(ref(anonymous.storage(), `trips/${id}/editor-save.ebirdtrip`)));
  await assertSucceeds(getBytes(ref(editor.storage(), `trips/${id}/editor-save.ebirdtrip`)));
  await assertFails(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), { pending: pending('legacy-overwrite') }),
  );
  await assertFails(updateDoc(workspaceRef(anonymous), { plan: { ...plan, name: 'Attack' } }));
  await assertFails(
    setDoc(workspaceRef(editor), {
      ...workspace,
      revision: 'plan-2',
      commitId: 'plan-2',
      generation: 2,
      privateLists: [],
    }),
  );
  await assertSucceeds(
    setDoc(workspaceRef(editor), {
      ...workspace,
      revision: 'plan-2',
      commitId: 'plan-2',
      generation: 2,
      plan: { ...plan, name: 'Shared edit' },
    }),
  );
  await assertFails(
    setDoc(workspaceRef(owner), {
      ...workspace,
      revision: 'stale-plan',
      commitId: 'stale-plan',
      generation: 2,
    }),
  );
  await assertFails(
    setDoc(workspaceRef(owner), {
      ...workspace,
      datasetRevision: 'other',
      revision: 'plan-3',
      commitId: 'plan-3',
      generation: 3,
    }),
  );
  await assertFails(deleteObject(ref(editor.storage(), `trips/${id}/editor-save.ebirdtrip`)));
  await assertSucceeds(updateDoc(doc(owner.firestore(), 'tripAccess', id), { editorEmails: [] }));
  await assertSucceeds(getDoc(workspaceRef(editor))); // Still a public visitor.
  await assertSucceeds(updateDoc(doc(owner.firestore(), 'cloudTrips', id), { public: false }));
  await assertFails(getDoc(workspaceRef(editor)));
  await assertFails(
    setDoc(workspaceRef(editor), {
      ...workspace,
      revision: 'revoked-plan',
      commitId: 'revoked-plan',
      generation: 3,
    }),
  );
  await assertFails(getBytes(ref(editor.storage(), `trips/${id}/editor-save.ebirdtrip`)));
  await assertFails(
    updateDoc(doc(editor.firestore(), 'cloudTrips', id), {
      pending: { ...pending('revoked'), uid: 'editor' },
    }),
  );
  const largePlan = buildWorkspacePlan({ name: 'Dense road route' }, [
    {
      workspaceId: 'route-stop',
      dateTime: '2026-02-16T07:00',
      latitude: 17,
      longitude: 54,
      routeGeometry: {
        type: 'LineString',
        coordinates: Array.from({ length: 41800 }, () => [54.123456, 17.123456]),
      },
    },
  ]);
  assert.ok(new TextEncoder().encode(JSON.stringify(largePlan)).length > 890 * 1024);
  validatePlanSize(largePlan);
  await assertSucceeds(
    setDoc(workspaceRef(owner), {
      ...workspace,
      revision: 'large-plan',
      commitId: 'large-plan',
      generation: 3,
      plan: largePlan,
    }),
  );
  assert.deepEqual((await getDoc(workspaceRef(owner))).data().plan, largePlan);
  await assertSucceeds(
    updateDoc(doc(owner.firestore(), 'cloudTrips', id), {
      revision: '',
      size: 0,
      public: false,
      pending: null,
    }),
  );
  await assertSucceeds(deleteObject(ref(owner.storage(), `trips/${id}/editor-save.ebirdtrip`)));
  const deletion = writeBatch(owner.firestore());
  deletion.delete(workspaceRef(owner));
  deletion.delete(doc(owner.firestore(), 'cloudTrips', id));
  deletion.delete(doc(owner.firestore(), 'tripAccess', id));
  await assertSucceeds(deletion.commit());
  console.log(
    'Cloud rules passed: private/public access, editor permissions, revocation, immutable revisions, quota and size limits.',
  );
} finally {
  await env.cleanup();
}
