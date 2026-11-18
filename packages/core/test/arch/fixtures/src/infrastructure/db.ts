// Allowed: infrastructure may depend on domain.
import type { Clock } from "../domain/ports.js";

export const db = { connectedAt: (clock: Clock): Date => clock.now() };
