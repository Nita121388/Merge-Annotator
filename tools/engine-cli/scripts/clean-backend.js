#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");

function main() {
  const pkgRoot = path.resolve(__dirname, "..");
  const backendDst = path.join(pkgRoot, "backend");
  if (fs.existsSync(backendDst)) {
    fs.rmSync(backendDst, { recursive: true, force: true });
    console.log("backend cleaned:", backendDst);
  }
}

main();
