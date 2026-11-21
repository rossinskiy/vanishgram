// Test and tooling helper: makes VanishClient use the real libsignal engine in this process.
import { setSignalFactory } from '@vanishgram/client-core';
import { SignalEngine } from './index.ts';
setSignalFactory(() => new SignalEngine());
