/**
 * Architecture rules for packages/core (see .kiro/steering/architecture-boundaries.md).
 *
 *   domain <- application <- (infrastructure, interfaces) <- main.*
 *
 * makeConfig(root) builds the rules for a source root. .dependency-cruiser.cjs applies
 * them to packages/core/src, and packages/core/test/arch applies the same rules to
 * fixtures that violate them on purpose.
 */

// Third-party packages that must stay out of domain/ and application/.
const FORBIDDEN_IN_INNER_LAYERS = [
  "mongodb",
  "bullmq",
  "ioredis",
  "redis",
  "fastify",
  "@fastify/[^/]+",
  "openai",
  "pino",
  "yaml",
  "ajv",
  "unpdf",
  "pdf-parse",
];

/**
 * @param {string} root Regex for the source root, for example "^packages/core/src".
 * @returns {import('dependency-cruiser').IConfiguration}
 */
function makeConfig(root) {
  const forbiddenPackages = `^(node_modules/)?(${FORBIDDEN_IN_INNER_LAYERS.join("|")})(/|$)`;

  return {
    forbidden: [
      {
        name: "domain-is-innermost",
        comment: "domain/ may import only other domain/ files (and zod, if needed).",
        severity: "error",
        from: { path: `${root}/domain/` },
        to: {
          dependencyTypesNot: ["core"],
          pathNot: [`${root}/domain/`, "^(node_modules/)?zod(/|$)"],
        },
      },
      {
        name: "domain-no-node-io",
        comment: "domain/ performs no I/O, so Node core modules are off limits.",
        severity: "error",
        from: { path: `${root}/domain/` },
        to: { dependencyTypes: ["core"] },
      },
      {
        name: "application-depends-on-domain-only",
        comment: "application/ talks to the outside world through ports in domain/.",
        severity: "error",
        from: { path: `${root}/application/` },
        to: { path: [`${root}/(infrastructure|interfaces)/`, `${root}/main\\.`] },
      },
      {
        name: "inner-layers-no-adapter-packages",
        comment:
          "Database, queue, HTTP, LLM SDK, logging, and parser packages belong in infrastructure/ or interfaces/.",
        severity: "error",
        from: { path: `${root}/(domain|application)/` },
        to: { path: forbiddenPackages },
      },
      {
        name: "infrastructure-not-to-interfaces",
        comment: "infrastructure/ implements ports and never reaches into interfaces/ or composition roots.",
        severity: "error",
        from: { path: `${root}/infrastructure/` },
        to: { path: [`${root}/interfaces/`, `${root}/main\\.`] },
      },
      {
        name: "interfaces-not-to-infrastructure",
        comment: "interfaces/ call application use cases. Only main.*.ts wires concrete adapters.",
        severity: "error",
        from: { path: `${root}/interfaces/` },
        to: { path: [`${root}/infrastructure/`, `${root}/main\\.`] },
      },
      {
        name: "no-circular",
        severity: "error",
        from: { path: root },
        to: { circular: true },
      },
      {
        name: "not-to-unresolvable",
        comment: "Every import must resolve. Usually a missing dependency or a typo.",
        severity: "error",
        from: { path: root },
        to: { couldNotResolve: true },
      },
      {
        name: "no-dev-deps-in-src",
        comment: "Production code must not depend on devDependencies.",
        severity: "error",
        from: { path: root },
        to: { dependencyTypes: ["npm-dev"] },
      },
    ],
    options: {
      doNotFollow: { path: "node_modules" },
      exclude: { path: "\\.test\\.ts$" },
      tsPreCompilationDeps: true,
      tsConfig: { fileName: "tsconfig.json" },
      enhancedResolveOptions: {
        exportsFields: ["exports"],
        conditionNames: ["import", "require", "node", "default", "types"],
        extensions: [".ts", ".js", ".json"],
      },
    },
  };
}

module.exports = { makeConfig };
