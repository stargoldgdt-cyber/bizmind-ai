/**
 * The integration engine.
 *
 * Importing this module registers every connector this build ships. Nothing
 * else registers one, so "which providers exist" has a single answer.
 *
 * The fixture connector is registered in every environment on purpose. It
 * cannot reach a network, it produces no production data, and a connection to
 * it still requires an owner to create one -- so it is inert unless somebody
 * deliberately connects it, and having it present means the engine is
 * exercisable anywhere.
 */

import { registerConnector } from "./contract"
import { fixtureConnector } from "./connectors/fixture"
import { googleSheetsConnector } from "./connectors/google-sheets"
import { wooCommerceConnector } from "./connectors/woocommerce"

registerConnector(fixtureConnector)
registerConnector(wooCommerceConnector)
registerConnector(googleSheetsConnector)

export {
  getConnector,
  isKnownProvider,
  registeredProviders,
  type Connector,
  type ConnectorContext,
  type FetchResult,
  type IntegrationProvider,
  type SyncResource,
  type WebhookIdentity,
} from "./contract"

export { receiveWebhook, type ReceiveOutcome } from "./webhooks/receive"
export { processWebhookEvents } from "./webhooks/process"
export { runSyncWorker, type WorkerResult } from "./sync/worker"
