import { doc, getDocFromServer, runTransaction, serverTimestamp } from 'firebase/firestore';
import { initCloud } from './firebaseCloud';
import { publicationDecision, validatePlanSize } from './workspacePlan';

export const getWorkspaceCloud = async (id, { legacy = false } = {}) => {
  const { database } = await initCloud();
  try {
    const snapshot = await getDocFromServer(doc(database, 'workspaces', id));
    return snapshot.exists() ? { id, ...snapshot.data() } : null;
  } catch (error) {
    // Older deployed rules have no workspace collection; keep legacy trips usable.
    if (legacy && error.code === 'permission-denied') return null;
    throw error;
  }
};

export const createWorkspaceCloud = async (id, datasetRevision, plan, commitId) => {
  validatePlanSize(plan);
  const { database } = await initCloud();
  return runTransaction(database, async (transaction) => {
    const target = doc(database, 'workspaces', id);
    const existing = await transaction.get(target);
    if (existing.exists()) return { id, ...existing.data() };
    const source = (await transaction.get(doc(database, 'cloudTrips', id))).data();
    if (source.revision !== datasetRevision)
      throw new Error('The source dataset changed. Reopen the trip before enabling autosave.');
    const workspace = {
      datasetRevision,
      revision: commitId,
      commitId,
      generation: 1,
      plan,
      updatedAt: serverTimestamp(),
    };
    transaction.set(target, workspace);
    return { id, ...workspace };
  });
};

export const publishWorkspacePlan = async (id, baseRevision, commitId, plan) => {
  validatePlanSize(plan);
  const { database } = await initCloud();
  return runTransaction(database, async (transaction) => {
    const target = doc(database, 'workspaces', id);
    const current = (await transaction.get(target)).data();
    const decision = publicationDecision(current, baseRevision, commitId);
    if (decision === 'acknowledged') return { id, ...current };
    if (decision === 'conflict') return { id, ...current, conflict: true };
    const workspace = {
      ...current,
      revision: commitId,
      commitId,
      generation: current.generation + 1,
      plan,
      updatedAt: serverTimestamp(),
    };
    transaction.set(target, workspace);
    return { id, ...workspace };
  });
};

export const workspaceUrl = (id, edit = false) => {
  const url = new URL(`${import.meta.env.BASE_URL}workspace`, window.location.origin);
  url.searchParams.set('cloud', id);
  if (edit) url.searchParams.set('edit', '1');
  return url.href;
};
