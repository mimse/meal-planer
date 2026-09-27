import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

type DatabasePathOptions = {
  readonly explicitPath?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly homeDirectory?: string;
  readonly workingDirectory?: string;
};

export function resolveDatabasePath(options: DatabasePathOptions = {}): string {
  const environment = options.environment ?? process.env;
  const workingDirectory = options.workingDirectory ?? process.cwd();
  const configuredPath = options.explicitPath ?? environment.MEALPLAN_DATABASE;

  if (configuredPath !== undefined) {
    if (configuredPath.trim().length === 0) {
      throw new Error("Database path cannot be empty");
    }
    return resolve(workingDirectory, configuredPath);
  }

  const dataDirectory = environment.XDG_DATA_HOME?.trim()
    || join(options.homeDirectory ?? homedir(), ".local", "share");
  return isAbsolute(dataDirectory)
    ? join(dataDirectory, "mealplaner", "mealplan.sqlite")
    : join(resolve(workingDirectory, dataDirectory), "mealplaner", "mealplan.sqlite");
}
