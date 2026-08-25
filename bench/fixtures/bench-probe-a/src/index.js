// Containment benchmark probe app a. The logic is shared with bench-probe-b
// in bench/shared/app.mjs — only the imports live here, because a bare
// specifier only resolves from inside a package (see that file's header), and
// only berth.yml differs between the two, which is the variable under test.
import { defineApp } from "@berth/sdk";
import { z } from "zod";
import { createProbeApp } from "../../../shared/app.mjs";

export default createProbeApp({ defineApp, z });
