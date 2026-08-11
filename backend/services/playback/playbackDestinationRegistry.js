import {
  assertPlaybackDestination,
  playbackOperationFailure,
} from "./playbackDestination.js";

export class PlaybackDestinationRegistry {
  constructor(destinations) {
    this.destinations = destinations.map((destination) => {
      assertPlaybackDestination(destination);
      for (const property of ["key", "name"]) {
        if (typeof destination[property] !== "string" || !destination[property].trim()) {
          throw new TypeError(`PlaybackDestination.${property} must be a non-empty string`);
        }
      }
      for (const method of ["isConfigured", "updateConfig"]) {
        if (typeof destination[method] !== "function") {
          throw new TypeError(`PlaybackDestination.${method} must be a function`);
        }
      }
      return destination;
    });
  }

  updateConfig(integrations = {}) {
    for (const destination of this.destinations) {
      destination.updateConfig(integrations[destination.key] || {});
    }
  }

  async run(operation, ...args) {
    return Promise.all(
      this.destinations.filter((destination) => destination.isConfigured()).map(
        async (destination) => {
          let result;
          try {
            result = await destination[operation](...args);
          } catch (error) {
            result = playbackOperationFailure({
              code: "DESTINATION_OPERATION_FAILED",
              message: error?.message || `${destination.name} ${operation} failed`,
              retryable: true,
            });
          }
          if (!result.ok) {
            console.warn(
              `[PlaybackDestinationRegistry] ${destination.name} ${operation} failed:`,
              result.error?.message,
            );
          }
          return { destination: destination.name, operation, ...result };
        },
      ),
    );
  }
}
