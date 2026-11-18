// Violation: inner-layers-no-adapter-packages
import { MongoClient } from "mongodb";

export const client = MongoClient;
