import { asAppError } from "../../../lib/errors.ts";
import {
  isRetryablePlaybackError,
  playbackOperationFailure,
  type PlaybackDestination,
  type PlaybackOperationResult,
  type PlaybackResultOperation,
} from "./playbackDestination.ts";

const DELETE_OPERATIONS = new Set(["deletePlaylist", "deleteEntityPlaylists"]);

export class PlaybackDestinationRegistry {
  declare destinations: PlaybackDestination[];

  constructor(destinations: PlaybackDestination[]) {
    this.destinations = destinations.map((destination) => {
      for (const property of ["key", "name"] as const) {
        if (typeof destination[property] !== "string" || !destination[property].trim()) {
          throw new TypeError(`PlaybackDestination.${property} must be a non-empty string`);
        }
      }
      return destination;
    });
  }

  updateConfig(integrations: Record<string, unknown> = {}) {
    for (const destination of this.destinations) {
      destination.updateConfig(integrations[destination.key] || {});
    }
  }

  async run(operation: PlaybackResultOperation, ...args: unknown[]) {
    return this.runOn(null, operation, ...args);
  }

  async runOn(keys: string[] | null, operation: PlaybackResultOperation, ...args: unknown[]) {
    return Promise.all(
      this.destinations
        .filter(
          (destination) =>
            (!keys || keys.includes(destination.key)) &&
            (DELETE_OPERATIONS.has(operation) || destination.isConfigured()),
        )
        .map(async (destination) => {
          let result: PlaybackOperationResult;
          try {
            result = await destination[operation](...args);
          } catch (error) {
            result = playbackOperationFailure({
              code: "DESTINATION_OPERATION_FAILED",
              message: asAppError(error)?.message || `${destination.name} ${operation} failed`,
              retryable: isRetryablePlaybackError(error),
            });
          }
          if (!result.ok) {
            console.warn(
              `[PlaybackDestinationRegistry] ${destination.name} ${operation} failed:`,
              result.error?.message,
            );
          }
          return { destination: destination.name, key: destination.key, operation, ...result };
        }),
    );
  }
}
