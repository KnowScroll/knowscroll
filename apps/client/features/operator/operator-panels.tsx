import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import type { OperatorPanelsResponse } from '@knowscroll/contracts';
import { clockOf, dayAndClockOf, hasJourney, spanOf, type OperatorUnavailableReason } from './operator-copy';
import { Box, Card, Chip, Line, Mono, Note, TextButton, Unavailable } from './operator-parts';
import { operatorColor } from './operator-theme';

type Available<T> =
  | { readonly status: 'available'; readonly data: T }
  | { readonly status: 'unavailable'; readonly reason: OperatorUnavailableReason };

/** A piece's rows when it can be read, otherwise the dashed "unavailable" box that names why. */
function Piece<T>({
  piece,
  label,
  children,
}: {
  readonly piece: Available<T>;
  readonly label: string;
  readonly children: (data: T) => ReactNode;
}) {
  if (piece.status === 'unavailable') return <Unavailable label={label} reason={piece.reason} />;
  return (
    <Box label={label}>
      <View style={styles.rows}>{children(piece.data)}</View>
    </Box>
  );
}

const nothing = (words: string) => (
  <Mono size={12} color={operatorColor.faint}>
    {words}
  </Mono>
);

const cents = (value: number) => `${String(value)}¢`;

export interface PanelActions {
  /** Opens the journey of an ID in the search card. */
  readonly lookUp: (id: string) => void;
}

/** 1 · System overview. */
export function OverviewCard({
  overview,
  actions,
}: {
  readonly overview: OperatorPanelsResponse['overview'];
  readonly actions: PanelActions;
}) {
  return (
    <Card
      title="1 · System overview"
      source="ops.queue_backlog · ops.model_attempts · ops.recent_errors"
      testID="operator-overview"
    >
      <View style={styles.pair}>
        <Unavailable label="service health" reason={overview.serviceHealth.reason} />
        <Unavailable label="request latency" reason={overview.requestLatency.reason} />
        <Unavailable label="media disk" reason={overview.mediaDisk.reason} />
      </View>
      <Piece piece={overview.queues} label="queue wait (age)">
        {(queues) =>
          queues.length === 0
            ? nothing('No queue has jobs yet.')
            : queues.map((queue) => (
                <Line key={queue.queue} attention={queue.failed > 0}>
                  <Mono size={12} color={operatorColor.ink}>
                    {queue.queue}
                  </Mono>
                  <Mono>ready {queue.ready}</Mono>
                  <Mono>active {queue.active}</Mono>
                  <Mono>retrying {queue.retrying}</Mono>
                  <Mono color={queue.failed > 0 ? operatorColor.attentionInk : operatorColor.strong}>
                    failed {queue.failed}
                  </Mono>
                  <Mono>
                    {queue.oldestWaitingSeconds === null
                      ? 'nothing waiting'
                      : `oldest ${spanOf(queue.oldestWaitingSeconds)}`}
                  </Mono>
                </Line>
              ))
        }
      </Piece>
      <Piece piece={overview.providerOutcomes} label="model attempts · last 24 h">
        {(outcomes) =>
          outcomes.length === 0 ? (
            nothing('No model attempts in the last 24 hours.')
          ) : (
            <View style={styles.chips}>
              {outcomes.map((outcome) => (
                <Chip key={outcome.state} attention={outcome.state === 'unknown' || outcome.state === 'failed'}>
                  {outcome.state} {outcome.count}
                </Chip>
              ))}
            </View>
          )
        }
      </Piece>
      <Note>Unknown outcomes are their own count, never folded into success or failure.</Note>
      <Piece piece={overview.recentErrors} label="recent errors">
        {(errors) =>
          errors.length === 0
            ? nothing('No failures or unknown outcomes recorded.')
            : errors.map((error) => (
                <Line key={`${error.source}-${error.refId}`} attention={error.state === 'failed'}>
                  <Mono>{dayAndClockOf(error.occurredAt)}</Mono>
                  <Mono color={operatorColor.ink}>{error.source}</Mono>
                  <Mono>{[error.state, error.code, error.label].filter((part) => part !== null).join(' ')}</Mono>
                  {hasJourney(error.source) ? (
                    <TextButton
                      label="Journey"
                      accessibilityLabel={`Open the journey of this ${error.source.replace('_', ' ')}`}
                      onPress={() => actions.lookUp(error.refId)}
                    />
                  ) : null}
                </Line>
              ))
        }
      </Piece>
    </Card>
  );
}

/** 3 · Content production. */
export function ProductionCard({
  production,
  actions,
}: {
  readonly production: OperatorPanelsResponse['production'];
  readonly actions: PanelActions;
}) {
  return (
    <Card
      title="3 · Content production"
      source="ops.production_runs · ops.rejected_answers · ops.reel_orders · ops.model_attempts"
      testID="operator-production"
    >
      <Piece piece={production.usage} label="provider usage · last 24 h">
        {(usage) => (
          <Mono>
            {usage.attempts} attempts · {usage.tokensReported} tokens reported · {usage.attemptsWithoutReportedUsage}{' '}
            sent without a reported usage
          </Mono>
        )}
      </Piece>
      <Piece piece={production.runs} label="Scroll production runs">
        {(runs) =>
          runs.length === 0
            ? nothing('No production run yet.')
            : runs.map((run) => (
                <Line key={run.productionRunId} attention={run.state === 'rejected' || run.state === 'unknown'}>
                  <Mono size={12} color={operatorColor.ink}>
                    {run.recipeKey} · take {run.take}
                  </Mono>
                  <Mono>{run.state}</Mono>
                  <Mono>writer {run.writerRunState ?? 'none'}</Mono>
                  <Mono>
                    {run.modelAttempts} attempts · {run.refusedAnswers} refused
                  </Mono>
                  <Mono>{dayAndClockOf(run.createdAt)}</Mono>
                  <TextButton
                    label="Journey"
                    accessibilityLabel={`Open the journey of the ${run.recipeKey} production run`}
                    onPress={() => actions.lookUp(run.productionRunId)}
                  />
                </Line>
              ))
        }
      </Piece>
      <Piece piece={production.refusedAnswers} label="refused writer answers">
        {(answers) =>
          answers.length === 0
            ? nothing('No refused answer is kept.')
            : answers.map((answer) => (
                <Line key={answer.attemptId} attention>
                  <Mono size={12} color={operatorColor.ink}>
                    {answer.reason ?? 'refused'}
                  </Mono>
                  <Mono>{answer.issueCodes.length === 0 ? 'no finding codes' : answer.issueCodes.join(', ')}</Mono>
                  <Mono>
                    {answer.issueCount} findings · {answer.answerChars} chars{answer.truncated ? ' (cut)' : ''}
                  </Mono>
                  <TextButton
                    label="Journey"
                    accessibilityLabel="Open the journey of this refused answer's attempt"
                    onPress={() => actions.lookUp(answer.attemptId)}
                  />
                </Line>
              ))
        }
      </Piece>
      <Piece piece={production.reelOrders} label="Reel orders">
        {(orders) =>
          orders.length === 0
            ? nothing('No Reel has been ordered.')
            : orders.map((order) => (
                <Line key={order.reelOrderId} attention={order.latestAttemptState === 'unknown'}>
                  <Mono size={12} color={operatorColor.ink}>
                    {order.scriptName} · until {order.until}
                  </Mono>
                  <Mono>{order.publishedAt === null ? 'not published' : 'published'}</Mono>
                  <Mono>
                    {order.attempts} attempts · latest {order.latestAttemptState ?? 'none'}
                  </Mono>
                  <Mono>
                    settled {cents(order.settledCents)} · claimed open {cents(order.claimedOpenCents)}
                  </Mono>
                  <TextButton
                    label="Journey"
                    accessibilityLabel={`Open the journey of the ${order.scriptName} Reel order`}
                    onPress={() => actions.lookUp(order.reelOrderId)}
                  />
                </Line>
              ))
        }
      </Piece>
      <Note>
        One shared job can serve several private requests; the links stay in scoped records, not in this list.
      </Note>
    </Card>
  );
}

/** 4 · Universe change. */
export function UniverseChangeCard({
  universeChange,
}: {
  readonly universeChange: OperatorPanelsResponse['universeChange'];
}) {
  return (
    <Card title="4 · Universe change" source="ops.geography_runs" testID="operator-universe-change">
      <Piece piece={universeChange.cartographer} label="Cartographer runs · last 7 days">
        {(cartographer) => (
          <>
            {cartographer.counts.length === 0 ? (
              nothing('No run in the last 7 days.')
            ) : (
              <View style={styles.chips}>
                {cartographer.counts.map((count) => (
                  <Chip key={count.state}>
                    {count.state} {count.count}
                  </Chip>
                ))}
              </View>
            )}
            {cartographer.recent.map((run) => (
              <Line key={run.runId}>
                <Mono>{dayAndClockOf(run.updatedAt)}</Mono>
                <Mono size={12} color={operatorColor.ink}>
                  {run.status}
                </Mono>
                <Mono>{run.outcome ?? 'no outcome yet'}</Mono>
                <Mono>revision {run.desiredRevision}</Mono>
              </Line>
            ))}
          </>
        )}
      </Piece>
      <Note>No psychological interpretation panel. This view explains a change, never what a person is.</Note>
    </Card>
  );
}

/** 5 · Realtime delivery. */
export function RealtimeCard({ realtime }: { readonly realtime: OperatorPanelsResponse['realtime'] }) {
  return (
    <Card title="5 · Realtime delivery" source="no durable source in Tier 0" testID="operator-realtime">
      <Unavailable label="delivery, reconnect and relay" reason={realtime.delivery.reason} />
      <Note>
        Hints are disposable and leave no record. A committed message is read from its own history. Message bodies are
        omitted everywhere in this view.
      </Note>
    </Card>
  );
}

/** 6 · Privacy and diagnostics health. */
export function PrivacyCard({ privacy }: { readonly privacy: OperatorPanelsResponse['privacy'] }) {
  return (
    <Card
      title="6 · Privacy & diagnostics health"
      source="ops.privacy_operations · ops.queue_backlog"
      testID="operator-privacy"
    >
      <Piece piece={privacy.operations} label="clear, deletion and export · last 30 days">
        {(operations) =>
          operations.groups.length === 0 ? (
            nothing('No privacy operation in the last 30 days.')
          ) : (
            <>
              {operations.groups.map((group) => (
                <Line key={`${group.kind}-${group.state}`}>
                  <Mono size={12} color={operatorColor.ink}>
                    {group.kind}
                  </Mono>
                  <Mono>{group.state}</Mono>
                  <Mono>{group.count}</Mono>
                  <Mono>since {dayAndClockOf(group.oldestRequestedAt)}</Mono>
                </Line>
              ))}
              {operations.failed.map((failure) => (
                <Line key={failure.operationId} attention>
                  <Mono size={12} color={operatorColor.attentionInk}>
                    {failure.kind} failed
                  </Mono>
                  <Mono>{failure.failureCode}</Mono>
                  <Mono>{clockOf(failure.requestedAt)}</Mono>
                </Line>
              ))}
            </>
          )
        }
      </Piece>
      <Piece piece={privacy.retentionJobs} label="retention jobs">
        {(jobs) =>
          jobs.length === 0
            ? nothing('No retention job has run yet.')
            : jobs.map((job) => (
                <Line key={job.queue} attention={job.failed > 0}>
                  <Mono size={12} color={operatorColor.ink}>
                    {job.queue}
                  </Mono>
                  <Mono>
                    {job.lastCompletedAt === null ? 'never completed' : `last ${dayAndClockOf(job.lastCompletedAt)}`}
                  </Mono>
                  <Mono>failed {job.failed}</Mono>
                </Line>
              ))
        }
      </Piece>
      <Unavailable label="dropped diagnostics · known gaps" reason={privacy.droppedDiagnostics.reason} />
      <Note>Erased data shows as erased, never rebuilt from logs.</Note>
    </Card>
  );
}

const styles = StyleSheet.create({
  rows: { gap: 2 },
  pair: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
});
