// Built only with WORKSPACE_TEST=true. Never included in a normal release build.
import { db } from '../../src/data/db';
import { initCloud, getCloudTrip, saveCloudTrip } from '../../src/utils/firebaseCloud';
import { signInWithCredential, GoogleAuthProvider } from 'firebase/auth';
import { refreshTrips, selectedTripId } from '../../src/state/tripSelection';
import { publishWorkspacePlan } from '../../src/utils/workspaceCloud';
import { encodeTripArchive } from '../../src/utils/tripArchive';
import { applyWorkspacePlan } from '../../src/utils/workspaceLocal';

window.workspaceTest = {
  saveCloudTrip,
  encodeTripArchive,
  db,
  initCloud,
  getCloudTrip,
  signInWithCredential,
  GoogleAuthProvider,
  refreshTrips,
  selectedTripId,
  publishWorkspacePlan,
  applyWorkspacePlan,
};
