import { doc, runTransaction, serverTimestamp } from 'firebase/firestore';
import { db } from '../data/db';
import { cloudUser, cloudBindings } from '../state/cloudTrips';
import { initCloud } from './firebaseCloud';

export const readPersonalLists = (tripId, accountId = cloudUser.value?.uid || '') =>
  db.personalLists.where('[tripId+accountId]').equals([tripId, accountId]).toArray();

// Claim old device-only flags once, then remove them from the shared dataset.
export const preparePersonalLists = (tripId) =>
  db.transaction('rw', db.ebd, db.personalLists, async () => {
    const ebd = await db.ebd.get(tripId);
    const accountId = cloudUser.value?.uid || '';
    for (const [kind, field] of [
      ['life', 'liferWorld'],
      ['region', 'liferRegion'],
    ]) {
      const values = Object.fromEntries(
        (ebd?.speciesList || []).filter((t) => t[field] != null).map((t) => [t.code, t[field]]),
      );
      const key = [tripId, accountId, kind];
      const guest = accountId ? await db.personalLists.get([tripId, '', kind]) : null;
      if (!(await db.personalLists.get(key)) && (Object.keys(values).length || guest))
        await db.personalLists.put({
          tripId,
          accountId,
          kind,
          values: guest?.values || values,
          revision: crypto.randomUUID(),
          dirty: true,
        });
      if (guest) await db.personalLists.delete([tripId, '', kind]);
    }
    if (ebd?.speciesList.some((t) => 'liferWorld' in t || 'liferRegion' in t))
      await db.ebd.update(tripId, {
        speciesList: ebd.speciesList.map(({ liferWorld, liferRegion, ...species }) => species),
      });
  });

export const savePersonalList = (tripId, kind, taxa) =>
  db.personalLists.put({
    tripId,
    accountId: cloudUser.value?.uid || '',
    kind,
    values: Object.fromEntries(
      [...taxa.values()].filter((t) => t[kind] != null).map((t) => [t.code, t[kind]]),
    ),
    revision: crypto.randomUUID(),
    dirty: true,
  });

// Each kind is replaced independently; an offline import wins when it reconnects.
// A clear is an empty record, so another device cannot resurrect the previous list.
export const syncPersonalLists = async (tripId, state) => {
  const accountId = cloudUser.value?.uid;
  if (!accountId || accountId !== state.accountId) return;
  const datasetRevision = cloudBindings.value[tripId]?.revision;
  if (!datasetRevision) return;
  const { database } = await initCloud();
  for (const kind of ['life', 'region']) {
    const key = [tripId, accountId, kind];
    const local = await db.personalLists.get(key);
    const target = doc(
      database,
      'personalTripLists',
      accountId,
      'trips',
      `${state.cloudId}_${datasetRevision}_${kind}`,
    );
    const saved = await runTransaction(database, async (transaction) => {
      const remote = (await transaction.get(target)).data();
      if (!local?.dirty) return remote;
      const record = {
        cloudId: state.cloudId,
        datasetRevision,
        kind,
        values: local.values,
        revision: local.revision,
        updatedAt: serverTimestamp(),
      };
      transaction.set(target, record);
      return record;
    });
    if (!saved) continue;
    await db.transaction('rw', db.personalLists, async () => {
      const current = await db.personalLists.get(key);
      // Keep an import made while the network request was in flight.
      if (current?.revision !== local?.revision) return;
      if (current?.revision === saved.revision && !current.dirty) return;
      await db.personalLists.put({
        tripId,
        accountId,
        kind,
        values: saved.values,
        revision: saved.revision,
        dirty: false,
      });
    });
  }
};
