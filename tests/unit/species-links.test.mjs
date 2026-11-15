import test from 'node:test';
import assert from 'node:assert/strict';
import { speciesMapBounds, speciesLinkUrls } from '../../src/utils/speciesLinks.js';
import { workspaceModel } from '../../src/utils/workspaceModel.js';

test('species links carry the dataset region and map extent to external services', () => {
  const model = workspaceModel({ stops: [] }, { region: { code: 'OM', name: 'Oman' } });
  const links = speciesLinkUrls(
    'osprey',
    model.region.code,
    speciesMapBounds([
      [54, 17],
      [59, 24],
    ]),
  );
  assert.equal(links.ebird, 'https://ebird.org/species/osprey/OM');
  assert.equal(links.bow, 'https://birdsoftheworld.org/bow/species/osprey/cur/introduction');
  const map = new URL(links.map);
  assert.equal(map.searchParams.get('zh'), 'true');
  assert.equal(map.searchParams.get('gp'), 'true');
  assert.equal(map.searchParams.get('env.minX'), '53.75');
  assert.equal(map.searchParams.get('env.maxY'), '24.35');
  for (const [kind, type] of [
    ['photos', 'p'],
    ['audio', 'a'],
  ]) {
    const params = new URL(links[kind]).searchParams;
    assert.equal(params.get('taxonCode'), 'osprey');
    assert.equal(params.get('regionCode'), 'OM');
    assert.equal(params.get('sort'), 'rating_rank_desc');
    assert.equal(params.get('mediaType'), type);
  }
});

test('links work without an imported region and maps give a single stop a visible extent', () => {
  const links = speciesLinkUrls('osprey', '', speciesMapBounds([[54, 17]]));
  assert.equal(links.ebird, 'https://ebird.org/species/osprey');
  assert.equal(new URL(links.photos).searchParams.has('regionCode'), false);
  assert.equal(new URL(links.map).searchParams.get('env.minX'), '53.95');
  assert.equal(new URL(links.map).searchParams.get('env.maxY'), '17.05');
  assert.deepEqual(speciesMapBounds([]), {});
});

test('a selected stop replaces the regional extent with bounds around the stop radius', () => {
  const region = [
    [54, 17],
    [59, 24],
  ];
  const bounds = speciesMapBounds(region, { coords: [56, 19], radius: 3 });
  assert.ok(bounds['env.minX'] > 55.95 && bounds['env.maxX'] < 56.05);
  assert.ok(bounds['env.minY'] < 18.975 && bounds['env.maxY'] > 19.025);
  assert.ok(Math.abs((bounds['env.minY'] + bounds['env.maxY']) / 2 - 19) < 0.00001);
});
