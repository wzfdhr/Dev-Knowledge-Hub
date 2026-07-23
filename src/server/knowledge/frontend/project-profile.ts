import {
  frontendProjectProfileDigest,
  frontendProjectProfileSchema,
  type FrontendProjectProfile,
  type SourceProvenanceV1
} from "../../../shared/frontend-project-profile.js";
import type { FrontendEntity, FrontendIR } from "../../../shared/frontend-ir.js";

import type { FrontendProjectManifest } from "./project-manifest.js";

export interface ProjectProfileInput {
  ir: FrontendIR;
  manifest: FrontendProjectManifest;
  sourceProvenance: SourceProvenanceV1;
}

type Unknown = { state: "unknown"; reason: "unresolved" };
const unknown = (): Unknown => ({ state: "unknown", reason: "unresolved" });
const known = <T>(value: T) => ({ state: "known" as const, value });

const dependencyNames = {
  framework: ["next", "nuxt", "@angular/core", "react", "vue", "svelte"],
  router: ["react-router-dom", "react-router", "vue-router", "@angular/router", "@sveltejs/kit", "next"],
  state: ["@reduxjs/toolkit", "redux", "zustand", "pinia", "mobx", "xstate"],
  data: ["@tanstack/react-query", "react-query", "swr", "axios", "@apollo/client", "urql"],
  form: ["react-hook-form", "formik", "final-form", "@tanstack/react-form", "vee-validate"],
  build: ["vite", "webpack", "rspack", "esbuild", "rollup", "turbopack", "parcel"],
  styles: ["tailwindcss", "styled-components", "@emotion/react", "sass", "less"],
  components: ["antd", "@mui/material", "@chakra-ui/react", "element-plus", "vuetify"],
  visualization: ["echarts", "recharts", "chart.js", "d3", "@ant-design/charts"],
  tests: ["vitest", "jest", "@playwright/test", "cypress", "@testing-library/react", "@testing-library/vue"]
} as const;

function dependencies(manifest: FrontendProjectManifest): Map<string, string> {
  return new Map(manifest.packages.flatMap((item) => Object.entries(item.dependencies))
    .sort(([left], [right]) => left.localeCompare(right)));
}

function matchingDependencies(
  available: ReadonlyMap<string, string>,
  candidates: readonly string[]
): string[] {
  return candidates.filter((name) => available.has(name)).sort();
}

function normalizedVersion(value: string): string {
  return value.match(/\d+(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?/u)?.[0] ?? value;
}

function frameworkValue(available: ReadonlyMap<string, string>) {
  const name = dependencyNames.framework.find((candidate) => available.has(candidate));
  if (!name) return unknown();
  const version = normalizedVersion(available.get(name)!);
  const major = Number.parseInt(version, 10);
  const minimum = name === "react" ? 18 : name === "vue" ? 3 : name === "svelte" ? 4 : 0;
  const supported = Number.isFinite(major) && major >= minimum;
  const value = { name, version, supported };
  return supported
    ? known(value)
    : { state: "unsupported" as const, reason: `unsupported ${name} version`, value };
}

function entitiesOf(ir: FrontendIR, kind: FrontendEntity["kind"]): FrontendEntity[] {
  return ir.entities.filter((entity) => entity.kind === kind)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function attributeValues(
  entities: readonly FrontendEntity[],
  attribute: string
): string[] {
  return [...new Set(entities.flatMap((entity) => {
    const value = (entity.attributes as Record<string, { state: string; value?: unknown }>)[attribute];
    return value?.state === "known" && typeof value.value === "string" ? [value.value] : [];
  }))].sort();
}

function sourceRefs(ir: FrontendIR) {
  const unique = new Map(ir.entities.flatMap((entity) => entity.sourceRefs).map((reference) => [
    `${reference.snapshotId}\0${reference.path}\0${reference.startLine}\0${reference.endLine}\0${reference.blobHash}`,
    reference
  ]));
  return [...unique.values()].sort((left, right) =>
    `${left.path}\0${left.startLine}\0${left.endLine}`.localeCompare(`${right.path}\0${right.startLine}\0${right.endLine}`)
  );
}

export function deriveFrontendProjectProfile(input: ProjectProfileInput): FrontendProjectProfile {
  const available = dependencies(input.manifest);
  const entries = entitiesOf(input.ir, "application_entry");
  const renderingModes: Array<"csr" | "ssr" | "ssg" | "rsc" | "worker" | "server"> = [...new Set(attributeValues(entries, "runtime").flatMap((runtime) => {
    if (runtime === "spa" || runtime === "client") return "csr";
    return ["ssr", "ssg", "worker", "server"].includes(runtime)
      ? [runtime as "ssr" | "ssg" | "worker" | "server"]
      : [];
  }))].sort();
  const routes = entitiesOf(input.ir, "route");
  const stores = entitiesOf(input.ir, "state_store");
  const operations = entitiesOf(input.ir, "api_operation");
  const tooling = entitiesOf(input.ir, "tooling_config");
  const styleScopes = entitiesOf(input.ir, "style_scope");
  const styleTokens = entitiesOf(input.ir, "style_token");
  const charts = entitiesOf(input.ir, "visualization");
  const testCases = entitiesOf(input.ir, "test_case");
  const packageEntities = entitiesOf(input.ir, "workspace_package");
  const packageManager = attributeValues(packageEntities, "packageManager")[0]
    ?? input.manifest.workspace?.packageManager
    ?? "unknown";
  const packageNames = input.manifest.packages.map((item) => item.name ?? item.root).sort();
  const testTools = matchingDependencies(available, dependencyNames.tests);
  const testScripts = input.manifest.packages.some((item) => Object.keys(item.scripts).some((name) => name === "test" || name.startsWith("test:")));
  const payload = {
    schemaVersion: 1 as const,
    snapshotId: input.ir.snapshotId,
    sourceProvenance: input.sourceProvenance,
    analyzerManifestDigest: input.ir.analyzerManifestDigest,
    framework: frameworkValue(available),
    rendering: renderingModes.length > 0 ? known({ modes: renderingModes }) : unknown(),
    router: routes.length > 0 || matchingDependencies(available, dependencyNames.router).length > 0
      ? known({ libraries: matchingDependencies(available, dependencyNames.router), routeCount: routes.length })
      : unknown(),
    state: stores.length > 0 || matchingDependencies(available, dependencyNames.state).length > 0
      ? known({ libraries: matchingDependencies(available, dependencyNames.state), storeCount: stores.length })
      : unknown(),
    data: operations.length > 0 || matchingDependencies(available, dependencyNames.data).length > 0
      ? known({ libraries: matchingDependencies(available, dependencyNames.data), operationCount: operations.length })
      : unknown(),
    formLibrary: matchingDependencies(available, dependencyNames.form).length > 0
      ? known({ libraries: matchingDependencies(available, dependencyNames.form) })
      : unknown(),
    tooling: tooling.length > 0 || matchingDependencies(available, dependencyNames.build).length > 0
      ? known({
          buildTools: matchingDependencies(available, dependencyNames.build),
          configs: [...new Set([...attributeValues(tooling, "tool"), ...tooling.map((item) => item.name)])].sort()
        })
      : unknown(),
    styles: styleScopes.length > 0 || styleTokens.length > 0
      || matchingDependencies(available, [...dependencyNames.styles, ...dependencyNames.components]).length > 0
      ? known({
          systems: [...new Set([
            ...attributeValues(styleScopes, "scopeKind"),
            ...matchingDependencies(available, dependencyNames.styles)
          ])].sort(),
          tokenCount: styleTokens.length,
          componentLibraries: matchingDependencies(available, dependencyNames.components)
        })
      : unknown(),
    visualizations: charts.length > 0 || matchingDependencies(available, dependencyNames.visualization).length > 0
      ? known({
          libraries: [...new Set([
            ...attributeValues(charts, "library"),
            ...matchingDependencies(available, dependencyNames.visualization)
          ])].sort(),
          count: charts.length
        })
      : unknown(),
    tests: testCases.length > 0 || testTools.length > 0 || testScripts
      ? known({ tools: testTools, kinds: attributeValues(testCases, "testKind"), caseCount: testCases.length })
      : unknown(),
    workspace: packageNames.length > 0 || packageEntities.length > 0
      ? known({
          kind: input.manifest.workspace || packageNames.length > 1 ? "monorepo" as const : "single-package" as const,
          packageManager: packageManager as "npm" | "pnpm" | "yarn" | "bun" | "unknown",
          packages: packageNames
        })
      : unknown(),
    sourceRefs: sourceRefs(input.ir)
  };
  return frontendProjectProfileSchema.parse({
    ...payload,
    profileDigest: frontendProjectProfileDigest(payload)
  });
}
