// pino and bunyan log numeric levels, which HyperDX's own JSON-level step ignores (it only takes strings).
const NUMERIC_LEVELS = [
  { level: 10, text: "trace", number: "SEVERITY_NUMBER_TRACE" },
  { level: 20, text: "debug", number: "SEVERITY_NUMBER_DEBUG" },
  { level: 30, text: "info", number: "SEVERITY_NUMBER_INFO" },
  { level: 40, text: "warn", number: "SEVERITY_NUMBER_WARN" },
  { level: 50, text: "error", number: "SEVERITY_NUMBER_ERROR" },
  { level: 60, text: "fatal", number: "SEVERITY_NUMBER_FATAL" },
];

// JSON is valid YAML, so the collector reads this output as-is.
export function buildGatewayCustomConfig(): string {
  const statements = NUMERIC_LEVELS.flatMap(({ level, text, number }) => {
    const match = `IsMatch(log.body.string, "\\"level\\":${level}[,}]")`;
    return [`set(log.severity_number, ${number}) where ${match}`, `set(log.severity_text, "${text}") where ${match}`];
  });

  return JSON.stringify(
    {
      processors: {
        // Sets severity before HyperDX's keyword guess, which skips records that already have one.
        "transform/severity": {
          error_mode: "ignore",
          log_statements: [
            { context: "log", conditions: ['severity_number == 0 and severity_text == ""'], statements },
          ],
        },
      },
      service: {
        pipelines: {
          "logs/out-default": { processors: ["memory_limiter", "transform/severity", "transform", "batch"] },
        },
      },
    },
    null,
    2,
  );
}
