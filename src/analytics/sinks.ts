/**
 * Sinks (plans/16 section 6a): how a batch of rows becomes HTTP requests for the backend the dev picked.
 *
 * - `basin`: one JSON array per stream (`POST <events>` and `POST <recordings>`), `Authorization: Bearer <token>`
 *   when a token is set, not compressed (Basin doesn't document gzip request bodies).
 * - `duckdb`: one `POST <events>` with `{"events":[...],"recordings":[...]}`, gzip (`Compress`), and
 *   `Authorization: Bearer <token>`.
 *
 * Rows are encoded here, column by column, so integers keep every digit (`t` is a 13-digit unix ms value).
 * Pure: no imports and no services, so it also runs offline under Lune (scripts/test-analytics.luau). The string
 * quoter is passed in (HttpService.JSONEncode of a string in game).
 */

import type { EventRow, IdentityRow, RecordingRow, ResolvedSettings } from "./schema";
import type { IdentityTarget } from "./settings";

type ColumnType = "int" | "string" | "bool";

/** The events table, in order. SCHEMA.md lists the same columns. */
export const EVENT_COLUMNS: ReadonlyArray<[name: keyof EventRow, type: ColumnType]> = [
	["v", "int"],
	["t", "int"],
	["kind", "string"],
	["name", "string"],
	["pid", "string"],
	["sid", "string"],
	["job", "string"],
	["srv", "string"],
	["place", "int"],
	["art", "string"],
	["seq", "int"],
	["branch", "string"],
	["channel", "string"],
	["dev", "string"],
	["newp", "bool"],
	["state", "string"],
	["exp", "string"],
	["sexp", "string"],
	["src", "string"],
	["props", "string"],
];

/** The recordings table, in order. */
export const RECORDING_COLUMNS: ReadonlyArray<[name: keyof RecordingRow, type: ColumnType]> = [
	["v", "int"],
	["t", "int"],
	["pid", "string"],
	["sid", "string"],
	["job", "string"],
	["art", "string"],
	["chunk", "int"],
	["codec", "string"],
	["data", "string"],
	["n", "int"],
];

/** Identity rows (never part of the events table). */
export const IDENTITY_COLUMNS: ReadonlyArray<[name: keyof IdentityRow, type: ColumnType]> = [
	["pid", "string"],
	["uid", "int"],
	["t", "int"],
];

export type Quote = (text: string) => string;

function encodeValue(value: unknown, kind: ColumnType, quote: Quote): string {
	if (kind === "int") {
		const number = typeIs(value, "number") && value === value && math.abs(value) < 2 ** 53 ? value : 0;
		return string.format("%d", number >= 0 ? math.floor(number) : -math.floor(-number));
	}
	if (kind === "bool") return value === true ? "true" : "false";
	return quote(typeIs(value, "string") ? value : "");
}

/** One row as a JSON object with exactly these columns (missing or wrong values become 0, false or ""). */
export function encodeRow(row: object, columns: ReadonlyArray<[string, ColumnType]>, quote: Quote): string {
	const values = row as Record<string, unknown>;
	const parts = new Array<string>();
	for (const [name, kind] of columns) parts.push(`"${name}":${encodeValue(values[name], kind, quote)}`);
	return `{${parts.join(",")}}`;
}

/** A JSON array of rows. */
export function encodeRows(rows: object[], columns: ReadonlyArray<[string, ColumnType]>, quote: Quote): string {
	const parts = new Array<string>();
	for (const row of rows) parts.push(encodeRow(row, columns, quote));
	return `[${parts.join(",")}]`;
}

/** A cheap upper-bound guess of a row's JSON size (for batch limits; no encoding). */
export function estimateEventBytes(row: EventRow): number {
	return 360 + row.props.size() + row.exp.size() + row.state.size() + row.name.size();
}

export function estimateRecordingBytes(row: RecordingRow): number {
	return 200 + row.data.size();
}

export interface SinkRequest {
	/** "events" or "recordings" (basin), "both" (duckdb), "identities" (basin: the fleet API). */
	table: "events" | "recordings" | "both" | "identities";
	url: string;
	body: string;
	gzip: boolean;
	headers: Record<string, string>;
	/** Rows in the request, per table. */
	events: number;
	recordings: number;
	identities: number;
}

function headersFor(settings: ResolvedSettings): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (settings.token !== undefined) headers.Authorization = `Bearer ${settings.token}`;
	return headers;
}

/**
 * The requests for one batch. basin: up to two (events, recordings: recordings without a recordings URL are not sent
 * and must not have been queued). duckdb: one with both tables.
 */
export function buildRequests(
	settings: ResolvedSettings,
	events: EventRow[],
	recordings: RecordingRow[],
	quote: Quote,
	identities: IdentityRow[] = [],
	target?: IdentityTarget,
): SinkRequest[] {
	const requests = new Array<SinkRequest>();
	const headers = headersFor(settings);
	if (settings.backend === "duckdb") {
		if (events.size() === 0 && recordings.size() === 0 && identities.size() === 0) return requests;
		// Identities ride in the same body, in their own array (never mixed into events).
		const who = identities.size() > 0 ? `,"identities":${encodeRows(identities, IDENTITY_COLUMNS, quote)}` : "";
		const body = `{"events":${encodeRows(events, EVENT_COLUMNS, quote)},"recordings":${encodeRows(recordings, RECORDING_COLUMNS, quote)}${who}}`;
		requests.push({ table: "both", url: settings.events, body, gzip: true, headers, events: events.size(), recordings: recordings.size(), identities: identities.size() });
		return requests;
	}
	if (events.size() > 0) {
		const body = encodeRows(events, EVENT_COLUMNS, quote);
		requests.push({ table: "events", url: settings.events, body, gzip: false, headers, events: events.size(), recordings: 0, identities: 0 });
	}
	if (recordings.size() > 0 && settings.recordings !== undefined) {
		const body = encodeRows(recordings, RECORDING_COLUMNS, quote);
		requests.push({ table: "recordings", url: settings.recordings, body, gzip: false, headers, events: 0, recordings: recordings.size(), identities: 0 });
	}
	// Basin rows can't be deleted, so identities go to the dev's fleet API instead (none without a target).
	if (identities.size() > 0 && target !== undefined) {
		const identityHeaders: Record<string, string> = { "Content-Type": "application/json" };
		if (target.token !== undefined) identityHeaders.Authorization = `Bearer ${target.token}`;
		const body = `{"identities":${encodeRows(identities, IDENTITY_COLUMNS, quote)}}`;
		requests.push({ table: "identities", url: target.url, body, gzip: false, headers: identityHeaders, events: 0, recordings: 0, identities: identities.size() });
	}
	return requests;
}
