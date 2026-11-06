import { afterAll, afterEach, beforeAll } from "vitest";
import { network } from "./network";
import { resetQueue } from "./queue";

beforeAll(() => network.enable());
afterEach(() => {
  network.resetHandlers();
  resetQueue();
});
afterAll(() => network.disable());
