import { Command } from "commander";
import { PRODUCT_NAME } from "../core/constants.js";
import { VERSION } from "../core/version.js";
import { captureCommand, controlCommand } from "./commands/capture.js";
import { criticCommand } from "./commands/critic.js";
import { doctorCommand } from "./commands/doctor.js";
import { indexCommand, queryCommand } from "./commands/graph.js";
import { guardCommand } from "./commands/guard.js";
import { installCommand } from "./commands/install.js";
import { learnCommand, recallCommand, reportCommand } from "./commands/memory.js";
import { observationsCommand } from "./commands/observations.js";
import { overrideCommand } from "./commands/override.js";
import { policyCommand } from "./commands/policy.js";
import {
  acceptCommand,
  briefCommand,
  doneCommand,
  featureCommand,
  handoffCommand,
  migrateCommand,
  nextCommand,
  prCommand,
  reproduceCommand,
  reviewCommand,
  statusCommand,
  verifyCommand,
  workCommand,
} from "./commands/product.js";
import { serveCommand } from "./commands/serve.js";
import { initCommand } from "./commands/setup.js";
import { skillCommand } from "./commands/skill.js";
import { usageCommand } from "./commands/usage.js";

export function buildProgram(
  options: {
    criticHost?: import("../workflow/product/critic.js").CriticAdapter;
    signal?: AbortSignal;
    userFeedbackHost?: import("../workflow/product/user-feedback.js").UserFeedbackHost;
  } = {},
): Command {
  const program = new Command(PRODUCT_NAME)
    .description("Harness for AI coding agents: executed checks, bounded scope and independent review")
    .version(VERSION, "-v, --version")
    .option("--project <path>", "Project root (defaults to the working directory)")
    .option("--json", "Print a single JSON envelope instead of text")
    .showHelpAfterError();

  program.addCommand(initCommand());
  program.addCommand(installCommand());
  program.addCommand(indexCommand());
  program.addCommand(queryCommand());
  program.addCommand(featureCommand());
  program.addCommand(briefCommand());
  program.addCommand(captureCommand());
  program.addCommand(controlCommand());
  program.addCommand(workCommand());
  program.addCommand(migrateCommand());
  program.addCommand(guardCommand());
  program.addCommand(verifyCommand());
  program.addCommand(reviewCommand());
  program.addCommand(reproduceCommand());
  program.addCommand(criticCommand(options.criticHost, options.signal, options.userFeedbackHost));
  program.addCommand(observationsCommand());
  program.addCommand(doneCommand());
  program.addCommand(acceptCommand());
  program.addCommand(prCommand());
  program.addCommand(nextCommand());
  program.addCommand(statusCommand());
  program.addCommand(handoffCommand());
  program.addCommand(doctorCommand());
  program.addCommand(learnCommand());
  program.addCommand(recallCommand());
  program.addCommand(reportCommand());
  program.addCommand(usageCommand());
  program.addCommand(policyCommand());
  program.addCommand(overrideCommand());
  program.addCommand(skillCommand());
  program.addCommand(serveCommand());

  return program;
}
