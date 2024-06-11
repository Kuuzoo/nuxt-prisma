import {
  defineNuxtModule,
  addPlugin,
  createResolver,
  addImportsDir,
  addServerScanDir,
} from "@nuxt/kit";
import { fileURLToPath } from "url";
import defu from "defu";
import type { PrismaExtendedModule } from "./runtime/types/prisma-module";
import { executeRequiredPrompts } from "./package-utils/prompts";
import {
  checkIfMigrationsFolderExists,
  checkIfPrismaSchemaExists,
  formatSchema,
  generateClient,
  initPrisma,
  installPrismaCLI,
  installStudio,
  isPrismaCLIInstalled,
  runMigration,
  writeClientInLib,
  writeToSchema,
} from "./package-utils/setup-helpers";
import { log, PREDEFINED_LOG_MESSAGES } from "./package-utils/log-helpers";

export default defineNuxtModule<PrismaExtendedModule>({
  meta: {
    name: "@prisma/nuxt",
    configKey: "prisma",
  },
  // Default configuration options of the Nuxt module
  defaults: {
    datasourceUrl: process.env.DATABASE_URL,
    log: [],
    errorFormat: "colorless",
    writeToSchema: true,
    formatSchema: true,
    runMigration: true,
    installClient: true,
    generateClient: true,
    installStudio: true,
    skipInstallations: false,
    autoSetupPrisma: false,
  },

  async setup(options, nuxt) {
    const { resolve: resolveProject } = createResolver(nuxt.options.rootDir);
    const { resolve: resolver } = createResolver(import.meta.url);
    const runtimeDir = fileURLToPath(new URL("./runtime", import.meta.url));

    // Identifies which script is running: posinstall, dev or prod
    const npm_lifecycle_event = import.meta.env.npm_lifecycle_event;

    const prepareModule = () => {
      // Enable server components for Nuxt
      nuxt.options.experimental.componentIslands ||= {};
      nuxt.options.experimental.componentIslands = true;

      // Do not add the extension since the `.ts` will be transpiled to `.mjs` after `npm run prepack`
      addPlugin(resolver("./runtime/plugin"));
      addImportsDir(resolver(runtimeDir, "composables"));

      // Auto-import from runtime/server/utils
      addServerScanDir(
        createResolver(import.meta.url).resolve("./runtime/server"),
      );

      nuxt.options.vite.optimizeDeps ||= {};
      nuxt.options.vite.optimizeDeps = {
        include: ["@prisma/nuxt > @prisma/client"],
      };
    };

    const force_skip_prisma_setup = import.meta.env.SKIP_PRISMA_SETUP ?? false;

    if (force_skip_prisma_setup) {
      log(PREDEFINED_LOG_MESSAGES.PRISMA_SETUP_SKIPPED_WARNING);
      prepareModule();
      return;
    }

    // exposing module options to application runtime
    nuxt.options.runtimeConfig.public.prisma = defu(
      nuxt.options.runtimeConfig.public.prisma || {},
      {
        log: options.log,
        errorFormat: options.errorFormat,
      },
    );

    const PROJECT_PATH = resolveProject();

    // Check if Prisma CLI is installed.
    const prismaInstalled = await isPrismaCLIInstalled(PROJECT_PATH);

    // if Prisma CLI is installed skip the following step.
    if (!prismaInstalled) {
      installPrismaCLI(PROJECT_PATH);
    }

    // Check if Prisma Schema exists
    const prismaSchemaExists = checkIfPrismaSchemaExists([
      resolveProject("prisma", "schema.prisma"),
      resolveProject("prisma", "schema"),
    ]);

    const prismaMigrateWorkflow = async () => {
      // Check if Prisma migrations folder exists
      const doesMigrationFolderExist = checkIfMigrationsFolderExists(
        resolveProject("prisma", "migrations"),
      );

      if (doesMigrationFolderExist) {
        // Skip migration as the migration folder exists
        return;
      }

      const migrateAndFormatSchema = async () => {
        await runMigration(PROJECT_PATH);
        await formatSchema(PROJECT_PATH);
      };

      if (options.autoSetupPrisma && options.runMigration) {
        await migrateAndFormatSchema();
      }

      const promptResult = await executeRequiredPrompts({
        promptForMigrate: true,
        promptForPrismaStudio: false,
      });

      if (promptResult?.promptForPrismaMigrate && options.runMigration) {
        await migrateAndFormatSchema();
      }

      log("Skipped running Prisma migrate.");

      return;
    };

    const prismaInitWorkflow = async () => {
      await initPrisma({
        directory: PROJECT_PATH,
        provider: "sqlite",
      });

      // Add dummy models to the Prisma schema
      await writeToSchema(resolveProject("prisma", "schema.prisma"));
      await prismaMigrateWorkflow();
    };

    const prismaStudioWorkflow = async () => {
      if (!options.installStudio || npm_lifecycle_event !== "dev") {
        log("Skipped installing Prisma Studio");
        return;
      }

      const installAndStartPrismaStudio = async () => {
        await installStudio(PROJECT_PATH);
        nuxt.hooks.hook("devtools:customTabs", (tab) => {
          tab.push({
            name: "nuxt-prisma",
            title: "Prisma Studio",
            icon: "simple-icons:prisma",
            category: "server",
            view: {
              type: "iframe",
              src: "http://localhost:5555/",
              persistent: true,
            },
          });
        });
      };

      if (options.autoSetupPrisma) {
        await installAndStartPrismaStudio();
        return;
      }

      const promptResults = await executeRequiredPrompts({
        promptForMigrate: false,
        promptForPrismaStudio: true,
      });

      if (promptResults?.promptForInstallingStudio) {
        await installAndStartPrismaStudio();
      }
    };

    if (!prismaSchemaExists) {
      await prismaInitWorkflow();
    } else {
      await prismaMigrateWorkflow();
    }

    await writeClientInLib(resolveProject("lib", "prisma.ts"));
    await generateClient(PROJECT_PATH);

    await prismaStudioWorkflow();

    prepareModule();
    return;
  },
});
