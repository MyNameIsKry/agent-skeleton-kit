// Allowed: application depends on a domain port.
import type { Clock } from "../domain/ports.js";

export const today = (clock: Clock): Date => clock.now();
