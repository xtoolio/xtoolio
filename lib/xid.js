// X ids are SNOWFLAKES: the milliseconds since X's epoch, shifted left 22 bits, so an id says when it was minted and
// ids sort by time (finer than created_at, which is whole seconds). THE one place this arithmetic lives: a time as an id
// (a stream's bookmark at a moment, the Inbox's start) and an id as a time. Pure.
"use strict";

const X_EPOCH_MS = 1288834974657n;

// The id X would mint at `ms` (epoch milliseconds): every post after that moment has a larger one. → a string id
const idAt = (ms) => String((BigInt(Math.floor(ms)) - X_EPOCH_MS) << 22n);
// An id minted now.
const idNow = () => idAt(Date.now());
// When `id` was minted. → Date
const timeOf = (id) => new Date(Number((BigInt(id) >> 22n) + X_EPOCH_MS));

module.exports = { X_EPOCH_MS, idAt, idNow, timeOf };
