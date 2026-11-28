// scripts import their API (`import { tweak } from "tangitweak"`): compile them
// as the background does, through the TS → JS transpiler
import "../src/shared/transpile";
// the sandbox (the only eval context) runs in-process
import "./inProcessSandbox";
