// Value Presets hover text: the full value when the widget draws it cut off.
// Runs the real helpers from web/obvpm_ui.js with a fixed-width measure, so
// the truncation arithmetic is checked against litegraph's layout numbers.
//
// Run: node tests/test_value_tooltip.mjs

import assert from "node:assert/strict";
import { isWidgetValueCutOff, valueTooltip } from "../web/obvpm_ui.js";

const measure = (text) => String(text).length * 10;   // 10 px per character
const DEFAULT = {};                                    // litegraph default mode

// node 300 px, combo: area = 300 - (30 + 5) - 30 - 20 = 215 px
const combo = (name, value) => ({ type: "combo", name, value });

let passed = 0;
function test(name, fn) {
    fn();
    passed += 1;
    console.log("ok  " + name);
}

test("short value fits: no tooltip beyond the usual one", () => {
    const w = combo("ckpt", "a.safetensors");               // 40 + 5 + 130 = 175 <= 215
    assert.equal(isWidgetValueCutOff(w, 300, measure, DEFAULT), false);
    assert.equal(valueTooltip(w, 300, undefined, measure, DEFAULT), undefined);
    assert.equal(valueTooltip(w, 300, "field error", measure, DEFAULT), "field error");
});

test("value wider than the whole area is cut: full value shown", () => {
    const w = combo("model", "a_very_long_checkpoint_name.safetensors");   // 390 px > 215
    assert.equal(isWidgetValueCutOff(w, 300, measure, DEFAULT), true);
    assert.equal(valueTooltip(w, 300, undefined, measure, DEFAULT),
                 "a_very_long_checkpoint_name.safetensors");
});

test("the usual tooltip follows the full value", () => {
    const w = combo("model", "a_very_long_checkpoint_name.safetensors");
    assert.equal(valueTooltip(w, 300, "model: not in UNETLoader's list", measure, DEFAULT),
                 "a_very_long_checkpoint_name.safetensors\n\nmodel: not in UNETLoader's list");
});

test("default mode shortens a long label first, so a fitting value is not cut", () => {
    const w = combo("an_extremely_long_field_name", "short.png");   // label 280, value 90 <= 215
    assert.equal(isWidgetValueCutOff(w, 300, measure, DEFAULT), false);
});

test("values-first and even modes cut the value as soon as both overflow", () => {
    const w = combo("an_extremely_long_field_name", "short.png");
    assert.equal(isWidgetValueCutOff(w, 300, measure, { truncateWidgetValuesFirst: true }), true);
    assert.equal(isWidgetValueCutOff(w, 300, measure, { truncateWidgetTextEvenly: true }), true);
});

test("text widgets have no arrow padding", () => {
    // node 300 px, text: area = 300 - 30 - 30 = 240 px; label 40 + 5 + value 190 = 235 fits
    const text = { type: "text", name: "note", value: "x".repeat(19) };
    assert.equal(isWidgetValueCutOff(text, 300, measure, DEFAULT), false);
    const asCombo = { ...text, type: "combo" };               // area 215: 235 overflows
    assert.equal(isWidgetValueCutOff(asCombo, 300, measure, {
        truncateWidgetValuesFirst: true }), true);
});

test("widening the node removes the tooltip", () => {
    const w = combo("model", "a_very_long_checkpoint_name.safetensors");
    assert.equal(isWidgetValueCutOff(w, 300, measure, DEFAULT), true);
    assert.equal(isWidgetValueCutOff(w, 600, measure, DEFAULT), false);   // area 515
});

test("toggles, empty values and unmeasured nodes never add a tooltip", () => {
    assert.equal(isWidgetValueCutOff({ type: "toggle", name: "t", value: true }, 50, measure), false);
    assert.equal(isWidgetValueCutOff(combo("x", ""), 50, measure, DEFAULT), false);
    assert.equal(isWidgetValueCutOff(combo("x", "long".repeat(40)), 0, measure, DEFAULT), false);
});

test("the displayed value and label are what is measured", () => {
    const w = { type: "number", name: "steps", label: "steps ✎", _displayValue: "20", value: 20 };
    assert.equal(isWidgetValueCutOff(w, 300, measure, DEFAULT), false);
    assert.equal(valueTooltip({ ...w, _displayValue: "9".repeat(30) }, 300, undefined, measure, DEFAULT), "20");
});

console.log(`\n${passed} passed`);
