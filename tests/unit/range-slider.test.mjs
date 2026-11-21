import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickHandle, valueAtPosition } from '../../src/utils/rangeSlider.js';

test('valueAtPosition maps the thumb travel span onto the range and snaps to the step', () => {
  // 140 px wide, 20 px thumb: travel runs from 10 to 130 px.
  assert.equal(valueAtPosition(10, 140, 20), 0);
  assert.equal(valueAtPosition(130, 140, 20), 1);
  assert.equal(valueAtPosition(70, 140, 20), 0.5);
  assert.equal(valueAtPosition(-50, 140, 20), 0);
  assert.equal(valueAtPosition(500, 140, 20), 1);
  assert.equal(valueAtPosition(41, 140, 20), 0.26);
});

test('pickHandle grabs the nearer handle', () => {
  assert.equal(pickHandle(0.1, 0, 0.95), 'low');
  assert.equal(pickHandle(0.8, 0, 0.95), 'high');
  assert.equal(pickHandle(0.475, 0, 0.95), 'low');
});

test('pickHandle lets the press side or first move decide when handles overlap', () => {
  assert.equal(pickHandle(0.2, 0.5, 0.5, 0.05), 'low');
  assert.equal(pickHandle(0.8, 0.5, 0.5, 0.05), 'high');
  assert.equal(pickHandle(0.52, 0.5, 0.5, 0.05), null);
});
