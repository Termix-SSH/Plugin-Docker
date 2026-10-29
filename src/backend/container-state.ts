/**
 * Container state snapshots and the events two of them imply, for the
 * docker.events service.
 *
 * Events come from diffing successive `ps -a` snapshots, so the poll interval
 * is the resolution: a container that stops and starts between two polls is
 * not reported. That is the tradeoff for not holding a `docker events` stream
 * open against every watched host.
 */
export {
  PS_STATE_FORMAT,
  diffContainerStates,
  parseContainerStates,
  type ContainerState,
  type DockerEventName,
} from "@termix-ssh/plugin-sdk/host-scripts";
