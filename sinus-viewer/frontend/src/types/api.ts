
/**
 * SINUS VIEWER — FRONTEND API CONTRACTS
 * =====================================
 *
 * Mirrors the public API contracts defined in:
 *     backend/app/api/schemas.py
 *
 * Responsibilities:
 * - Strongly typed authentication responses.
 * - Dataset / patient / series browser contracts.
 * - Technical validation issue summaries.
 * - DICOM volume geometry in LPS coordinates.
 * - Full and preview volume level descriptors.
 * - Grayscale navigation preview metadata.
 * - Binary streaming metadata and range requests.
 * - Health responses and standardized API errors.
 * - Safe, lightweight runtime contract validation.
 *
 * SECURITY:
 * - No patient names, real PatientID values, DICOM UIDs,
 *   original file paths, or authentication tokens.
 * - Browser-visible identifiers are opaque handles.
 * - Do not print raw API responses or credentials.
 * - TypeScript interfaces do not validate network data;
 *   use runtime guards where appropriate.
 *
 * This module performs no network or filesystem operations.
 */


// ============================================================
// 01 — SHARED PRIMITIVE TYPES
// ============================================================

export type OpaqueHandle = string;

export type RequestId = string;

export type UnixTimestampSeconds = number;

export type CoordinateSystem = "LPS";

export type VolumeAxisOrder = "zyx";

export type VolumeDataType = "float32";

export type VolumeByteOrder = "little";

export type PreviewDataType = "uint8";

export type VolumeFormat = "sinus-viewer-volume-v1";

export type StreamEncoding = "sinus-viewer-f32-zyx-v1";

export type PreviewPlane =
  | "axial"
  | "coronal"
  | "sagittal";

export type VolumePlane =
  | PreviewPlane
  | "volume";

export type Vector3 = readonly [
  number,
  number,
  number,
];

export type Shape2 = readonly [
  number,
  number,
];

export type Shape3 = readonly [
  number,
  number,
  number,
];

export type Direction9 = readonly [
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
  number,
];


// ============================================================
// 02 — SUCCESS / ERROR ENVELOPES
// ============================================================

export interface APISuccess {
  readonly success: true;
}

export interface APIError {
  readonly code: PublicErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly request_id: RequestId | null;
}

export interface APIErrorResponse {
  readonly success: false;
  readonly error: APIError;
}


// ============================================================
// 03 — SAFE ERROR CODES
// ============================================================

export const PUBLIC_ERROR_CODES = [
  "AUTH_REQUIRED",
  "AUTH_FAILED",
  "SESSION_EXPIRED",
  "ACCESS_DENIED",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "REQUEST_TOO_LARGE",
  "PATH_REJECTED",
  "DATASET_NOT_FOUND",
  "PATIENT_NOT_FOUND",
  "SERIES_NOT_FOUND",
  "SERIES_INVALID",
  "SOURCE_CHANGED",
  "DECODER_ERROR",
  "OUT_OF_MEMORY",
  "RANGE_NOT_SATISFIABLE",
  "OPERATION_CANCELLED",
  "SERVICE_UNAVAILABLE",
  "PROCESSING_FAILED",
  "CONFIG_ERROR",
  "HTTPS_REQUIRED",
] as const;

export type PublicErrorCode =
  (typeof PUBLIC_ERROR_CODES)[number];

export const SAFE_ERROR_MESSAGES: Readonly<
  Record<PublicErrorCode, string>
> = {
  AUTH_REQUIRED: "Authentication is required.",
  AUTH_FAILED: "Authentication failed.",
  SESSION_EXPIRED: "Session expired.",
  ACCESS_DENIED: "Access denied.",
  RATE_LIMITED: "Too many requests.",
  INVALID_REQUEST: "Invalid request.",
  REQUEST_TOO_LARGE: "Request too large.",
  PATH_REJECTED: "Dataset path rejected.",
  DATASET_NOT_FOUND: "Dataset not found.",
  PATIENT_NOT_FOUND: "Patient not found.",
  SERIES_NOT_FOUND: "Series not found.",
  SERIES_INVALID: "Series is not volume-ready.",
  SOURCE_CHANGED: "Source data changed.",
  DECODER_ERROR: "Image decoding failed.",
  OUT_OF_MEMORY: "Memory limit exceeded.",
  RANGE_NOT_SATISFIABLE: "Invalid byte range.",
  OPERATION_CANCELLED: "Operation cancelled.",
  SERVICE_UNAVAILABLE: "Service unavailable.",
  PROCESSING_FAILED: "Processing failed.",
  CONFIG_ERROR: "Service configuration error.",
  HTTPS_REQUIRED: "Secure transport required.",
};


// ============================================================
// 04 — AUTHENTICATION
// ============================================================

export interface LoginRequest {
  readonly username: string;
  readonly password: string;
}

export interface SessionStatus {
  readonly authenticated: true;
  readonly expires_at: UnixTimestampSeconds;
}

export interface LoginResponse extends APISuccess {
  readonly session: SessionStatus;
}

export interface LogoutResponse extends APISuccess {
  readonly authenticated: false;
}


// ============================================================
// 05 — DATASET SESSION
// ============================================================

export interface DatasetSelectRequest {
  readonly dataset_path: string;
}

export type DatasetStatus =
  | "ready"
  | "scanning"
  | "closed";

export interface DatasetSummary {
  readonly dataset_session_id: OpaqueHandle;
  readonly state: DatasetStatus;
  readonly generation: number;
  readonly patient_count: number;
  readonly series_count: number;
  readonly dicom_files: number;
}

export interface DatasetResponse extends APISuccess {
  readonly dataset: DatasetSummary;
}

export interface DatasetListResponse extends APISuccess {
  readonly datasets: readonly DatasetSummary[];
}

export interface DatasetCloseResponse extends APISuccess {
  readonly closed: true;
}


// ============================================================
// 06 — PATIENT AND SERIES BROWSER
// ============================================================

/**
 * PatientSummary deliberately excludes:
 * - PatientName
 * - PatientID
 * - BirthDate
 * - Original folder name
 * - Study / Series DICOM UID
 */
export interface PatientSummary {
  readonly patient_handle: OpaqueHandle;
  readonly series_count: number;
  readonly volume_ready_series: number;
}

export interface PatientListResponse extends APISuccess {
  readonly dataset_session_id: OpaqueHandle;
  readonly patients: readonly PatientSummary[];
}

export interface SeriesSummary {
  readonly series_handle: OpaqueHandle;
  readonly patient_handle: OpaqueHandle;
  readonly modality: string | null;
  readonly slice_count: number;
  readonly rows: number;
  readonly columns: number;
  readonly volume_ready: boolean;
}

export interface SeriesListResponse extends APISuccess {
  readonly dataset_session_id: OpaqueHandle;
  readonly patient_handle: OpaqueHandle;
  readonly series: readonly SeriesSummary[];
}


// ============================================================
// 07 — SERIES VALIDATION
// ============================================================

export type ValidationSeverity =
  | "info"
  | "warning"
  | "error";

export interface SeriesIssue {
  readonly code: string;
  readonly severity: ValidationSeverity;
}

export interface SeriesValidationResponse
  extends APISuccess {
  readonly series_handle: OpaqueHandle;
  readonly valid: boolean;
  readonly volume_ready: boolean;
  readonly file_count: number;
  readonly frame_count: number;
  readonly issues: readonly SeriesIssue[];
}


// ============================================================
// 08 — MEDICAL IMAGING GEOMETRY
// ============================================================

/**
 * Geometry contract:
 *
 * shape_zyx:
 *     Array dimensions in Z, Y, X order.
 *
 * spacing_xyz_mm:
 *     Physical spacing in X, Y, Z order (millimetres).
 *
 * origin_lps:
 *     World origin in DICOM LPS coordinates.
 *
 * direction_lps:
 *     Row-major 3x3 direction matrix.
 *
 * Important:
 * A displayed axial/coronal/sagittal slice needs proper
 * orientation and spacing calculations; do not assume
 * the image axes align with the screen axes.
 */
export interface VolumeGeometry {
  readonly shape_zyx: Shape3;
  readonly spacing_xyz_mm: Vector3;
  readonly origin_lps: Vector3;
  readonly direction_lps: Direction9;
  readonly coordinate_system: "LPS";
}


// ============================================================
// 09 — VOLUME LEVELS
// ============================================================

export interface VolumeLevel {
  readonly level: number;
  readonly is_preview: boolean;
  readonly shape_zyx: Shape3;
  readonly byte_size: number;
  readonly dtype: VolumeDataType;
  readonly axis_order: VolumeAxisOrder;
  readonly byte_order: VolumeByteOrder;
  readonly geometry: VolumeGeometry;
}

export interface VolumeDescriptor {
  readonly format: VolumeFormat;
  readonly coordinate_system: CoordinateSystem;
  readonly levels: readonly VolumeLevel[];
}

export interface VolumeResponse extends APISuccess {
  readonly series_handle: OpaqueHandle;
  readonly volume: VolumeDescriptor;
}


// ============================================================
// 10 — GRAYSCALE PREVIEW METADATA
// ============================================================

export interface PreviewImage {
  readonly plane: PreviewPlane;
  readonly shape_yx: Shape2;
  readonly dtype: PreviewDataType;
  readonly byte_size: number;
  readonly sampled_slice_count: number;
  readonly representative_slice_index: number;
  readonly window_low: number;
  readonly window_high: number;
  readonly diagnostic_quality: false;
}

export interface PreviewDescriptor {
  readonly axial: PreviewImage;
  readonly coronal: PreviewImage;
  readonly sagittal: PreviewImage;
  readonly diagnostic_quality: false;
}

export interface PreviewResponse extends APISuccess {
  readonly series_handle: OpaqueHandle;
  readonly previews: PreviewDescriptor;
}


// ============================================================
// 11 — BINARY STREAMING
// ============================================================

export interface StreamRangeRequest {
  readonly level: number;
  readonly offset: number;
  readonly length: number;
}

export interface StreamDescriptor {
  readonly level: number;
  readonly total_bytes: number;
  readonly content_length: number;
  readonly chunk_size_bytes: number;
  readonly status_code: 200 | 206;
  readonly is_partial: boolean;
  readonly content_type: "application/octet-stream";
  readonly encoding: StreamEncoding;
}

export interface StreamResponse extends APISuccess {
  readonly stream: StreamDescriptor;
}

/**
 * Runtime HTTP response headers for a streamed volume.
 *
 * Content-Range may be absent for HTTP 200.
 * Content-Length refers to the response body, not
 * necessarily the total size of the volume.
 */
export interface StreamResponseHeaders {
  readonly contentLength: number;
  readonly contentRange: string | null;
  readonly acceptRanges: string | null;
  readonly contentType: string;
}


// ============================================================
// 12 — HEALTH
// ============================================================

export type HealthStatus =
  | "ok"
  | "degraded";

export interface HealthResponse {
  readonly status: HealthStatus;
  readonly service: "sinus-viewer";
}

export interface HealthComponent {
  readonly available: boolean;
  readonly closed: boolean;
}

export interface OperationalCounters {
  readonly active_dataset_sessions: number;
  readonly active_volume_loads: number;
  readonly active_preview_builds: number;
  readonly active_binary_streams: number;
  readonly cached_volumes: number;
  readonly cached_memory_mib: number;
  readonly active_login_sessions: number;
  readonly volume_load_requests: number;
  readonly completed_volume_loads: number;
  readonly failed_volume_loads: number;
  readonly completed_previews: number;
  readonly failed_previews: number;
  readonly completed_streams: number;
  readonly failed_streams: number;
}

export type HealthComponentName =
  | "authentication"
  | "datasets"
  | "cache"
  | "volumes"
  | "previews"
  | "streaming";

export interface OperationalHealthResponse {
  readonly status: HealthStatus;
  readonly service: "sinus-viewer";
  readonly components: Readonly<
    Record<HealthComponentName, HealthComponent>
  >;
  readonly counters: OperationalCounters;
}

export interface HealthCapabilitiesResponse {
  readonly service: "sinus-viewer";
  readonly schema_version: "1";
  readonly public_health: true;
  readonly authenticated_details: true;
  readonly volume_cache: true;
  readonly volume_streaming: true;
  readonly preview_service: true;
  readonly read_only_dataset: true;
  readonly runtime_integration_verified: false;
}


// ============================================================
// 13 — SAFE RUNTIME TYPE HELPERS
// ============================================================

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export function isOpaqueHandle(
  value: unknown,
): value is OpaqueHandle {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128
  ) {
    return false;
  }

  for (const character of value) {
    const code = character.charCodeAt(0);

    const alphaUpper = code >= 65 && code <= 90;
    const alphaLower = code >= 97 && code <= 122;
    const digit = code >= 48 && code <= 57;

    if (
      !alphaUpper &&
      !alphaLower &&
      !digit &&
      character !== "_" &&
      character !== "-"
    ) {
      return false;
    }
  }

  return true;
}

export function isPublicErrorCode(
  value: unknown,
): value is PublicErrorCode {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(
      SAFE_ERROR_MESSAGES,
      value,
    )
  );
}

export function isAPIErrorResponse(
  value: unknown,
): value is APIErrorResponse {
  if (!isRecord(value) || value.success !== false) {
    return false;
  }

  const detail = value.error;

  if (!isRecord(detail)) {
    return false;
  }

  return (
    isPublicErrorCode(detail.code) &&
    detail.message === SAFE_ERROR_MESSAGES[detail.code] &&
    typeof detail.retryable === "boolean" &&
    (
      detail.request_id === null ||
      (
        typeof detail.request_id === "string" &&
        /^[a-f0-9]{32}$/.test(detail.request_id)
      )
    )
  );
}

export function isSessionStatus(
  value: unknown,
): value is SessionStatus {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.authenticated === true &&
    typeof value.expires_at === "number" &&
    Number.isFinite(value.expires_at) &&
    value.expires_at > 0
  );
}

export function isLoginResponse(
  value: unknown,
): value is LoginResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    isSessionStatus(value.session)
  );
}

export function isDatasetSummary(
  value: unknown,
): value is DatasetSummary {
  if (!isRecord(value)) {
    return false;
  }

  const stateIsValid =
    value.state === "ready" ||
    value.state === "scanning" ||
    value.state === "closed";

  return (
    isOpaqueHandle(value.dataset_session_id) &&
    stateIsValid &&
    isPositiveInteger(value.generation) &&
    isNonNegativeInteger(value.patient_count) &&
    isNonNegativeInteger(value.series_count) &&
    isNonNegativeInteger(value.dicom_files)
  );
}

export function isPatientSummary(
  value: unknown,
): value is PatientSummary {
  if (!isRecord(value)) {
    return false;
  }

  return (
    isOpaqueHandle(value.patient_handle) &&
    isNonNegativeInteger(value.series_count) &&
    isNonNegativeInteger(value.volume_ready_series) &&
    value.volume_ready_series <= value.series_count
  );
}

export function isSeriesSummary(
  value: unknown,
): value is SeriesSummary {
  if (!isRecord(value)) {
    return false;
  }

  const validModality =
    value.modality === null ||
    (
      typeof value.modality === "string" &&
      /^[A-Za-z0-9_-]{0,16}$/.test(value.modality)
    );

  return (
    isOpaqueHandle(value.series_handle) &&
    isOpaqueHandle(value.patient_handle) &&
    validModality &&
    isNonNegativeInteger(value.slice_count) &&
    isNonNegativeInteger(value.rows) &&
    isNonNegativeInteger(value.columns) &&
    typeof value.volume_ready === "boolean"
  );
}

export function isHealthResponse(
  value: unknown,
): value is HealthResponse {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.service === "sinus-viewer" &&
    (
      value.status === "ok" ||
      value.status === "degraded"
    )
  );
}


// ============================================================
// 14 — NUMERIC VALIDATION HELPERS
// ============================================================

export function isNonNegativeInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

export function isPositiveInteger(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0
  );
}

export function isFinitePositiveNumber(
  value: unknown,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0
  );
}

export function isShape3(
  value: unknown,
): value is Shape3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(isPositiveInteger)
  );
}

export function isVector3(
  value: unknown,
): value is Vector3 {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (component: unknown) =>
        typeof component === "number" &&
        Number.isFinite(component),
    )
  );
}


// ============================================================
// 15 — VOLUME GEOMETRY RUNTIME GUARD
// ============================================================

export function isVolumeGeometry(
  value: unknown,
): value is VolumeGeometry {
  if (!isRecord(value)) {
    return false;
  }

  const spacing = value.spacing_xyz_mm;
  const direction = value.direction_lps;

  if (
    !isShape3(value.shape_zyx) ||
    !isVector3(value.origin_lps) ||
    !isVector3(spacing) ||
    value.coordinate_system !== "LPS"
  ) {
    return false;
  }

  if (!spacing.every(isFinitePositiveNumber)) {
    return false;
  }

  if (
    !Array.isArray(direction) ||
    direction.length !== 9 ||
    !direction.every(
      (component: unknown) =>
        typeof component === "number" &&
        Number.isFinite(component),
    )
  ) {
    return false;
  }

  // Orthogonality and unit-length are checked by backend
  // Pydantic and must be checked again in imaging math.
  return true;
}


// ============================================================
// 16 — VOLUME CONTRACT RUNTIME GUARD
// ============================================================

export function isVolumeLevel(
  value: unknown,
): value is VolumeLevel {
  if (!isRecord(value)) {
    return false;
  }

  if (
    !isNonNegativeInteger(value.level) ||
    value.level > 64 ||
    typeof value.is_preview !== "boolean" ||
    value.is_preview !== (value.level > 0) ||
    !isShape3(value.shape_zyx) ||
    !isPositiveInteger(value.byte_size) ||
    value.dtype !== "float32" ||
    value.axis_order !== "zyx" ||
    value.byte_order !== "little" ||
    !isVolumeGeometry(value.geometry)
  ) {
    return false;
  }

  const shape = value.shape_zyx;
  const expectedBytes = shape[0] * shape[1] * shape[2] * 4;

  if (
    !Number.isSafeInteger(expectedBytes) ||
    expectedBytes !== value.byte_size
  ) {
    return false;
  }

  const geometry = value.geometry;

  return (
    shape[0] === geometry.shape_zyx[0] &&
    shape[1] === geometry.shape_zyx[1] &&
    shape[2] === geometry.shape_zyx[2]
  );
}

export function isVolumeResponse(
  value: unknown,
): value is VolumeResponse {
  if (
    !isRecord(value) ||
    value.success !== true ||
    !isOpaqueHandle(value.series_handle)
  ) {
    return false;
  }

  const volume = value.volume;

  if (
    !isRecord(volume) ||
    volume.format !== "sinus-viewer-volume-v1" ||
    volume.coordinate_system !== "LPS" ||
    !Array.isArray(volume.levels) ||
    volume.levels.length < 1 ||
    volume.levels.length > 65 ||
    !volume.levels.every(isVolumeLevel)
  ) {
    return false;
  }

  const levels = volume.levels as VolumeLevel[];
  const indices = levels.map((level) => level.level);

  return (
    indices.includes(0) &&
    new Set(indices).size === indices.length
  );
}


// ============================================================
// 17 — SAFE API ERROR MESSAGE
// ============================================================

export function getSafeAPIErrorMessage(
  code: PublicErrorCode,
): string {
  return SAFE_ERROR_MESSAGES[code];
}


// ============================================================
// 18 — STATIC API CONTRACT CAPABILITIES
// ============================================================

export function getAPIContractCapabilities() {
  return {
    schemaVersion: "1",
    authenticatedSession: true,
    opaqueHandles: true,
    patientIdentifiersIncluded: false,
    sourcePathsIncluded: false,
    coordinateSystem: "LPS",
    volumeAxisOrder: "zyx",
    volumeDataType: "float32",
    volumeByteOrder: "little",
    runtimeGuards: true,
  } as const;
}


// ============================================================
// END OF FRONTEND API CONTRACTS
// ============================================================
