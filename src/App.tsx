import {useEffect, useMemo, useRef, useState} from "react";
import {Canvas, useThree} from "@react-three/fiber";
import {Line, OrbitControls, Stars, useTexture} from "@react-three/drei";
import {Body, DEG2RAD, Equator, EquatorFromVector, GeoVector, Horizon, Illumination, MoonPhase, Observer, SearchMoonPhase, SearchRiseSet, SiderealTime} from "astronomy-engine";
import {Compass, Square} from "lucide-react";
import {magvar} from "magvar";
import tzlookup from "tz-lookup";
import {DateTime} from "luxon";
import {AdditiveBlending, BackSide, Color, DirectionalLight, Matrix4, Quaternion, SRGBColorSpace, Vector3} from "three";
import {Button} from "@/components/ui/button";
import {Input} from "@/components/ui/input";
import {Label} from "@/components/ui/label";
import {Slider} from "@/components/ui/slider";
import earthCloudsTexture from "./assets/planets/earth-clouds.png";
import earthDayTexture from "./assets/planets/earth-day.jpg";
import earthSpecularTexture from "./assets/planets/earth-specular.jpg";
import moonTexture from "./assets/planets/moon.jpg";
import worldMapTexture from "./assets/world-map.jpg";
import "./App.css";

type SkyPoint = {
  azimuth: number;
  altitude: number;
  relativeAzimuth: number;
  timeMs?: number;
};

type Vec3 = {
  x: number;
  y: number;
  z: number;
};

type SubsolarPoint = {
  latitude: number;
  longitude: number;
};

type HorizonEventLabel = {
  rise: string;
  set: string;
  riseName: string;
  setName: string;
};

type ChartPointer = {
  x: number;
  y: number;
};

type CompassStatus = "idle" | "requesting" | "active" | "unsupported" | "denied" | "error";

type CompassState = {
  status: CompassStatus;
  message: string;
  magneticHeading: number | null;
  trueHeading: number | null;
  accuracy: number | null;
  declination: number;
  pointingAltitude: number | null;
};

type DeviceOrientationPermissionState = "granted" | "denied";

type DeviceOrientationEventConstructorWithPermission = typeof DeviceOrientationEvent & {
  requestPermission?: (absolute?: boolean) => Promise<DeviceOrientationPermissionState>;
};

type SafariDeviceOrientationEvent = DeviceOrientationEvent & {
  webkitCompassAccuracy?: number;
  webkitCompassHeading?: number;
};

type DeviceOrientationSnapshot = {
  alpha: number | null;
  beta: number | null;
  gamma: number | null;
};

type HorizonCrossing = {
  x: number;
  y: number;
  color: string;
  label: string;
  labelY: number;
  timeMs: number | null;
  isRise: boolean;
};

type SkyDiskHover = {
  panoramaX: number;
  y: number;
  label: string;
  labelY: number;
  hitRadius: number;
};

type StaticSkyScene = {
  canvas: HTMLCanvasElement;
  crossings: HorizonCrossing[];
  diskHovers: SkyDiskHover[];
  width: number;
  height: number;
};

const minutesPerDay = 24 * 60;
const msPerMinute = 60 * 1000;
const msPerHour = 60 * msPerMinute;
const msPerDay = 24 * msPerHour;
const skyPathSampleMinutes = 3;

const normalizeSignedDegrees = (degrees: number) => {
  let value = degrees;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
};

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);

const interpolateWrappedDegrees = (start: number, end: number, fraction: number) => start + normalizeSignedDegrees(end - start) * fraction;

const deviceSightlineAltitude = ({beta}: DeviceOrientationSnapshot) => {
  if (!isFiniteNumber(beta)) return null;

  return Math.asin(Math.sin(beta * DEG2RAD)) / DEG2RAD;
};

const observingTimeZone = (lat: number, lon: number) => {
  try {
    return tzlookup(lat, lon);
  } catch {
    return "UTC";
  }
};

const civicInstantMillis = (zoneId: string, instantMs: number, patch: Partial<{year: number; month: number; day: number; hour: number; minute: number}>) => {
  const base = DateTime.fromMillis(instantMs, {zone: "utc"}).setZone(zoneId);
  const next = DateTime.fromObject(
    {
      year: patch.year ?? base.year,
      month: patch.month ?? base.month,
      day: patch.day ?? base.day,
      hour: patch.hour ?? base.hour,
      minute: patch.minute ?? base.minute,
      second: 0,
      millisecond: 0,
    },
    {zone: zoneId},
  );
  return next.isValid ? next.toUTC().toMillis() : instantMs;
};

/** Month/day spinners can emit values outside 1–12 / 1–31; Luxon `set` rolls into adjacent calendar units. */
const civicSetMonthOrDayMillis = (zoneId: string, instantMs: number, part: {month: number} | {day: number}) => {
  const base = DateTime.fromMillis(instantMs, {zone: "utc"}).setZone(zoneId);
  const n = "month" in part ? Math.trunc(part.month) : Math.trunc(part.day);
  if (!Number.isFinite(n)) return instantMs;
  const next =
    "month" in part
      ? base.set({month: n, second: 0, millisecond: 0})
      : base.set({day: n, second: 0, millisecond: 0});
  return next.isValid ? next.toUTC().toMillis() : instantMs;
};

const civicEventTimeLabel = (date: Date | null, zoneId: string, civicDayStartUtc: Date) => {
  if (!date) return "No event";
  const t = DateTime.fromMillis(date.getTime(), {zone: "utc"}).setZone(zoneId);
  const dayStart = DateTime.fromMillis(civicDayStartUtc.getTime(), {zone: "utc"}).setZone(zoneId);
  const nextDay = dayStart.plus({days: 1});
  let suffix = "";
  if (t < dayStart) suffix = " (prior day)";
  else if (t >= nextDay) suffix = " (next day)";
  return `${t.toFormat("HH:mm")}${suffix}`;
};

const toDurationLabel = (from: Date, to: Date | null) => {
  if (!to) return "Unavailable";

  const diffMs = Math.max(0, to.getTime() - from.getTime());
  const days = Math.floor(diffMs / msPerDay);
  const hours = Math.round((diffMs - days * msPerDay) / msPerHour);

  if (days === 0) return `${hours}h`;
  if (hours === 24) return `${days + 1}d`;
  return `${days}d ${hours}h`;
};

const toMoonPhaseName = (phaseDegrees: number) => {
  const phase = normalizeDegrees(phaseDegrees);
  if (phase < 22.5 || phase >= 337.5) return "New Moon";
  if (phase < 67.5) return "Waxing Crescent";
  if (phase < 112.5) return "First Quarter";
  if (phase < 157.5) return "Waxing Gibbous";
  if (phase < 202.5) return "Full Moon";
  if (phase < 247.5) return "Waning Gibbous";
  if (phase < 292.5) return "Last Quarter";
  return "Waning Crescent";
};

const toMoonTrend = (phaseDegrees: number) => {
  const phase = normalizeDegrees(phaseDegrees);
  if (phase < 2 || phase > 358) return "turning new";
  if (Math.abs(phase - 180) < 2) return "turning full";
  return phase < 180 ? "waxing" : "waning";
};

const nextPhaseTime = (targetPhase: number, date: Date) => SearchMoonPhase(targetPhase, date, 40)?.date ?? null;

const bodyHorizontal = (body: Body, date: Date, observer: Observer) => {
  const equatorial = Equator(body, date, observer, true, true);
  return Horizon(date, observer, equatorial.ra, equatorial.dec, "normal");
};

const skyPointAtTime = (body: Body, observer: Observer, timeMs: number, facingDegrees: number, altitudeOverride?: number): SkyPoint => {
  const horizontal = bodyHorizontal(body, new Date(timeMs), observer);
  return {
    azimuth: horizontal.azimuth,
    altitude: altitudeOverride ?? horizontal.altitude,
    relativeAzimuth: normalizeSignedDegrees(horizontal.azimuth - facingDegrees),
    timeMs,
  };
};

const buildSampledSkyPath = (body: Body, observer: Observer, startMs: number, endMs: number, facingDegrees: number) => {
  const points: SkyPoint[] = [];

  const appendPoint = (timeMs: number) => {
    points.push(skyPointAtTime(body, observer, timeMs, facingDegrees));
  };

  for (let timeMs = startMs; timeMs <= endMs; timeMs += skyPathSampleMinutes * msPerMinute) {
    appendPoint(timeMs);
  }

  if (points.at(-1)?.timeMs !== endMs) {
    appendPoint(endMs);
  }

  return points;
};

const buildLocalDayPath = (body: Body, observer: Observer, start: Date, facingDegrees: number) => {
  return buildSampledSkyPath(body, observer, start.getTime(), start.getTime() + minutesPerDay * msPerMinute, facingDegrees);
};

const collectRiseSetEvents = (body: Body, observer: Observer, direction: 1 | -1, startMs: number, endMs: number) => {
  const events: Date[] = [];
  let cursor = new Date(startMs);

  while (cursor.getTime() < endMs) {
    const event = SearchRiseSet(body, observer, direction, cursor, Math.max(1, (endMs - cursor.getTime()) / msPerDay))?.date ?? null;
    if (!event || event.getTime() > endMs) break;
    events.push(event);
    cursor = new Date(event.getTime() + msPerMinute);
  }

  return events;
};

const findLastBefore = (events: Date[], timeMs: number) => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index].getTime() <= timeMs) return events[index];
  }

  return null;
};

const unwrapRelativeAzimuths = (points: SkyPoint[], anchorTimeMs: number) => {
  if (points.length === 0) return points;

  const unwrapped = points.map((point) => ({...point}));
  let previous = unwrapped[0].relativeAzimuth;
  unwrapped[0].relativeAzimuth = previous;

  for (let index = 1; index < unwrapped.length; index += 1) {
    const current = unwrapped[index].relativeAzimuth;
    previous += normalizeSignedDegrees(current - normalizeSignedDegrees(previous));
    unwrapped[index].relativeAzimuth = previous;
  }

  const anchorPoint = unwrapped.reduce((nearest, point) => {
    if (point.timeMs === undefined || nearest.timeMs === undefined) return nearest;
    return Math.abs(point.timeMs - anchorTimeMs) < Math.abs(nearest.timeMs - anchorTimeMs) ? point : nearest;
  }, unwrapped[0]);
  const offset = normalizeSignedDegrees(anchorPoint.relativeAzimuth) - anchorPoint.relativeAzimuth;

  return unwrapped.map((point) => ({...point, relativeAzimuth: point.relativeAzimuth + offset}));
};

const buildDisplayPath = (body: Body, observer: Observer, currentTime: Date, localDayStartUtc: Date, facingDegrees: number) => {
  const currentMs = currentTime.getTime();
  const searchStartMs = currentMs - 3 * msPerDay;
  const searchEndMs = currentMs + 3 * msPerDay;
  const rises = collectRiseSetEvents(body, observer, 1, searchStartMs, searchEndMs);
  const sets = collectRiseSetEvents(body, observer, -1, searchStartMs, searchEndMs);
  const currentAltitude = bodyHorizontal(body, currentTime, observer).altitude;

  const previousRise = findLastBefore(rises, currentMs);
  const nextRise = rises.find((event) => event.getTime() > currentMs) ?? null;
  const previousSet = findLastBefore(sets, currentMs);
  const nextSet = sets.find((event) => event.getTime() > currentMs) ?? null;

  if (currentAltitude >= 0 && previousRise && nextSet) {
    return unwrapRelativeAzimuths(buildSampledSkyPath(body, observer, previousRise.getTime() - 4 * msPerHour, nextSet.getTime() + 4 * msPerHour, facingDegrees), currentMs);
  }

  const followingSet = nextRise ? (sets.find((event) => event.getTime() > nextRise.getTime()) ?? null) : null;
  if (previousSet && nextRise && followingSet) {
    return unwrapRelativeAzimuths(buildSampledSkyPath(body, observer, previousSet.getTime(), followingSet.getTime() + 4 * msPerHour, facingDegrees), currentMs);
  }

  return unwrapRelativeAzimuths(buildLocalDayPath(body, observer, localDayStartUtc, facingDegrees), currentMs);
};

const toSceneVector = (vector: Vec3) => new Vector3(vector.x, vector.z, vector.y);
const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;

/** Sky-chart horizontal axis: linear azimuth in degrees (same as `(x / width) * 360 - 360`). */
const interpolateAltitudeAtDisplayAzimuth = (rawPoints: SkyPoint[], displaySkyDeg: number, preferNearTimeMs: number | null = null): number | null => {
  const targetWrapped = normalizeDegrees(displaySkyDeg);
  const hits: {altitude: number; timeMs: number}[] = [];

  for (let index = 1; index < rawPoints.length; index += 1) {
    const p = rawPoints[index - 1];
    const q = rawPoints[index];
    const a0 = p.relativeAzimuth;
    const a1 = q.relativeAzimuth;
    const da = a1 - a0;
    if (Math.abs(da) > 180 || Math.abs(da) < 1e-9) continue;

    const mid = (a0 + a1) / 2;
    const kCenter = Math.round((mid - targetWrapped) / 360);

    for (let k = kCenter - 3; k <= kCenter + 3; k += 1) {
      const aim = targetWrapped + 360 * k;
      const t = (aim - a0) / da;
      if (t >= 0 && t <= 1) {
        const altitude = p.altitude + t * (q.altitude - p.altitude);
        const pMs = p.timeMs;
        const qMs = q.timeMs;
        const timeMs = pMs !== undefined && qMs !== undefined ? pMs + t * (qMs - pMs) : preferNearTimeMs ?? 0;
        hits.push({altitude, timeMs});
        break;
      }
    }
  }

  if (hits.length === 0) return null;
  if (preferNearTimeMs !== null && hits.every((h) => Number.isFinite(h.timeMs))) {
    return hits.sort((a, b) => Math.abs(a.timeMs - preferNearTimeMs) - Math.abs(b.timeMs - preferNearTimeMs))[0].altitude;
  }

  return hits[0].altitude;
};

const drawSkyViewport = (canvas: HTMLCanvasElement, scene: StaticSkyScene, facingDegrees: number, pointingAltitude: number | null, pointer: ChartPointer | null) => {
  const context = canvas.getContext("2d");
  if (!context) return;

  if (canvas.width !== scene.width) canvas.width = scene.width;
  if (canvas.height !== scene.height) canvas.height = scene.height;

  const sourceX = ((normalizeDegrees(facingDegrees) + 180) / 360) * scene.width;
  context.clearRect(0, 0, scene.width, scene.height);
  context.drawImage(scene.canvas, sourceX, 0, scene.width, scene.height, 0, 0, scene.width, scene.height);

  const yFromAlt = (altitude: number) => scene.height - ((altitude + 90) / 180) * scene.height;
  const horizonY = yFromAlt(0);

  context.fillStyle = "#d9e2f2";
  context.font = "12px system-ui";
  context.fillText("horizon", 10, horizonY - 8);

  context.fillStyle = "#8f9cb2";
  context.font = "11px system-ui";
  [
    {label: "behind", azimuth: -180},
    {label: "left", azimuth: -90},
    {label: "ahead", azimuth: 0},
    {label: "right", azimuth: 90},
    {label: "behind", azimuth: 180},
  ].forEach(({label, azimuth}) => {
    const x = ((azimuth + 180) / 360) * scene.width;
    const textWidth = context.measureText(label).width;
    context.fillText(label, Math.min(scene.width - textWidth - 6, Math.max(6, x - textWidth / 2)), scene.height - 10);
  });

  if (pointingAltitude !== null) {
    const targetRadius = 10;
    const targetX = scene.width / 2;
    const targetY = yFromAlt(pointingAltitude);

    context.save();
    context.strokeStyle = "#ffffff";
    context.lineWidth = 2;
    context.shadowColor = "rgba(0, 0, 0, 0.72)";
    context.shadowBlur = 4;
    context.beginPath();
    context.arc(targetX, targetY, targetRadius, 0, Math.PI * 2);
    context.stroke();
    context.restore();
  }

  const hitRadiusCrossing = 22;
  const hoveredTooltip = pointer
    ? [...scene.crossings, ...scene.diskHovers].reduce<{visibleX: number; y: number; label: string; labelY: number; hitRadius: number; distance: number} | null>(
        (nearest, target) => {
          const panoramaX = "x" in target ? target.x : target.panoramaX;
          const hitRadius = "hitRadius" in target && target.hitRadius !== undefined ? target.hitRadius : hitRadiusCrossing;
          const visibleX = panoramaX - sourceX;
          const distance = Math.hypot(pointer.x - visibleX, pointer.y - target.y);
          if (distance > hitRadius) return nearest;
          if (!nearest || distance < nearest.distance) {
            return {visibleX, y: target.y, label: target.label, labelY: target.labelY, hitRadius, distance};
          }
          return nearest;
        },
        null,
      )
    : null;

  canvas.style.cursor = hoveredTooltip ? "pointer" : "default";
  if (!hoveredTooltip) return;

  context.font = "600 12px system-ui";
  context.textBaseline = "middle";

  const paddingX = 7;
  const paddingY = 4;
  const radius = 4;
  const textWidth = context.measureText(hoveredTooltip.label).width;
  const badgeWidth = textWidth + paddingX * 2;
  const badgeHeight = 20 + paddingY;
  const badgeX = Math.min(scene.width - badgeWidth - 6, Math.max(6, hoveredTooltip.visibleX + 8));
  const badgeY = Math.min(scene.height - badgeHeight - 6, Math.max(6, hoveredTooltip.labelY - badgeHeight / 2));

  context.fillStyle = "#ffffff";
  context.strokeStyle = "rgba(0, 0, 0, 0.45)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(badgeX + radius, badgeY);
  context.lineTo(badgeX + badgeWidth - radius, badgeY);
  context.quadraticCurveTo(badgeX + badgeWidth, badgeY, badgeX + badgeWidth, badgeY + radius);
  context.lineTo(badgeX + badgeWidth, badgeY + badgeHeight - radius);
  context.quadraticCurveTo(badgeX + badgeWidth, badgeY + badgeHeight, badgeX + badgeWidth - radius, badgeY + badgeHeight);
  context.lineTo(badgeX + radius, badgeY + badgeHeight);
  context.quadraticCurveTo(badgeX, badgeY + badgeHeight, badgeX, badgeY + badgeHeight - radius);
  context.lineTo(badgeX, badgeY + radius);
  context.quadraticCurveTo(badgeX, badgeY, badgeX + radius, badgeY);
  context.closePath();
  context.fill();
  context.stroke();

  context.fillStyle = "#05070d";
  context.fillText(hoveredTooltip.label, badgeX + paddingX, badgeY + badgeHeight / 2);
  context.textBaseline = "alphabetic";
};

const getSubsolarPoint = (date: Date): SubsolarPoint => {
  const sunGeo = GeoVector(Body.Sun, date, true);
  const sunEquator = EquatorFromVector(sunGeo);

  return {
    latitude: sunEquator.dec,
    longitude: normalizeSignedDegrees((sunEquator.ra - SiderealTime(date)) * 15),
  };
};

const toCompassDirection = (degrees: number) => {
  const directions = ["North", "North-northeast", "Northeast", "East-northeast", "East", "East-southeast", "Southeast", "South-southeast", "South", "South-southwest", "Southwest", "West-southwest", "West", "West-northwest", "Northwest", "North-northwest"];
  const index = Math.round(normalizeDegrees(degrees) / 22.5) % directions.length;
  return directions[index];
};

const compassMessage = (state: CompassState) => {
  if (state.status === "active" && state.trueHeading !== null) {
    const accuracyNote = state.accuracy !== null && state.accuracy > 20 ? ` • low accuracy ±${Math.round(state.accuracy)}°` : state.accuracy !== null ? ` • accuracy ±${Math.round(state.accuracy)}°` : "";
    const declinationPrefix = state.declination >= 0 ? "+" : "";
    return `Using iPhone compass at selected pin • declination ${declinationPrefix}${state.declination.toFixed(1)}°${accuracyNote}`;
  }

  return state.message;
};

function useDeviceHeading({latitude, longitude, onHeading}: {latitude: number; longitude: number; onHeading: (headingDegrees: number) => void}) {
  const declination = useMemo(() => {
    try {
      return magvar(latitude, longitude, 0);
    } catch {
      return 0;
    }
  }, [latitude, longitude]);
  const [compassState, setCompassState] = useState<CompassState>({
    status: "idle",
    message: "Compass off",
    magneticHeading: null,
    trueHeading: null,
    accuracy: null,
    declination,
    pointingAltitude: null,
  });
  const activeRef = useRef(false);
  const declinationRef = useRef(declination);
  const magneticHeadingRef = useRef<number | null>(null);
  const onHeadingRef = useRef(onHeading);
  const orientationRef = useRef<DeviceOrientationSnapshot>({alpha: null, beta: null, gamma: null});

  useEffect(() => {
    onHeadingRef.current = onHeading;
  }, [onHeading]);

  const handleOrientation = useMemo(
    () => (event: Event) => {
      const orientationEvent = event as SafariDeviceOrientationEvent;
      orientationRef.current = {
        alpha: orientationEvent.alpha,
        beta: orientationEvent.beta,
        gamma: orientationEvent.gamma,
      };
      const pointingAltitude = deviceSightlineAltitude(orientationRef.current);

      if (!isFiniteNumber(orientationEvent.webkitCompassHeading)) return;

      const magneticHeading = normalizeDegrees(orientationEvent.webkitCompassHeading);
      const accuracy = isFiniteNumber(orientationEvent.webkitCompassAccuracy) ? orientationEvent.webkitCompassAccuracy : null;
      const trueHeading = normalizeDegrees(magneticHeading + declinationRef.current);

      magneticHeadingRef.current = magneticHeading;
      onHeadingRef.current(trueHeading);
      setCompassState({
        status: "active",
        message: "Using iPhone compass",
        magneticHeading,
        trueHeading,
        accuracy,
        declination: declinationRef.current,
        pointingAltitude,
      });
    },
    [],
  );

  const removeListeners = useMemo(
    () => () => {
      window.removeEventListener("deviceorientation", handleOrientation);
      window.removeEventListener("deviceorientationabsolute", handleOrientation);
    },
    [handleOrientation],
  );

  const stop = useMemo(
    () => () => {
      if (typeof window !== "undefined") removeListeners();
      activeRef.current = false;
      setCompassState((current) => ({
        ...current,
        status: "idle",
        message: current.trueHeading === null ? "Compass off" : "Compass stopped",
      }));
    },
    [removeListeners],
  );

  const start = useMemo(
    () => async () => {
      if (typeof window === "undefined" || !("DeviceOrientationEvent" in window)) {
        setCompassState((current) => ({
          ...current,
          status: "unsupported",
          message: "Device orientation is not available in this browser.",
          declination: declinationRef.current,
          pointingAltitude: null,
        }));
        return;
      }

      if (!window.isSecureContext) {
        setCompassState((current) => ({
          ...current,
          status: "error",
          message: "Compass requires HTTPS on iOS Safari. Use npm run dev:https on your local network.",
          declination: declinationRef.current,
          pointingAltitude: null,
        }));
        return;
      }

      const DeviceOrientationWithPermission = window.DeviceOrientationEvent as DeviceOrientationEventConstructorWithPermission;
      setCompassState((current) => ({
        ...current,
        status: "requesting",
        message: "Requesting compass permission...",
        declination: declinationRef.current,
        pointingAltitude: null,
      }));

      try {
        if (typeof DeviceOrientationWithPermission.requestPermission === "function") {
          const permission = await DeviceOrientationWithPermission.requestPermission(true);
          if (permission !== "granted") {
            activeRef.current = false;
            setCompassState((current) => ({
              ...current,
              status: "denied",
              message: "Compass permission was denied.",
              declination: declinationRef.current,
              pointingAltitude: null,
            }));
            return;
          }
        }

        removeListeners();
        activeRef.current = true;
        window.addEventListener("deviceorientation", handleOrientation);
        window.addEventListener("deviceorientationabsolute", handleOrientation);
        setCompassState((current) => ({
          ...current,
          status: "active",
          message: "Waiting for iPhone compass heading...",
          declination: declinationRef.current,
          pointingAltitude: null,
        }));
      } catch (error) {
        activeRef.current = false;
        setCompassState((current) => ({
          ...current,
          status: "error",
          message: error instanceof Error ? error.message : "Unable to start the compass.",
          declination: declinationRef.current,
          pointingAltitude: null,
        }));
      }
    },
    [handleOrientation, removeListeners],
  );

  useEffect(() => {
    declinationRef.current = declination;
    setCompassState((current) => ({...current, declination}));

    const magneticHeading = magneticHeadingRef.current;
    if (!activeRef.current || magneticHeading === null) return;

    const trueHeading = normalizeDegrees(magneticHeading + declination);
    onHeadingRef.current(trueHeading);
    setCompassState((current) => ({
      ...current,
      trueHeading,
      declination,
    }));
  }, [declination]);

  useEffect(() => {
    return () => {
      removeListeners();
      activeRef.current = false;
    };
  }, [removeListeners]);

  return {
    compassState,
    start,
    stop,
    isActive: compassState.status === "active",
    pointingAltitude: compassState.pointingAltitude,
  };
}

const kilometersPerAstronomicalUnit = 149_597_870.7;
const earthMeanRadiusKm = 6371;
const moonMeanRadiusKm = 1737.4;
const earthRadiiPerAstronomicalUnit = kilometersPerAstronomicalUnit / earthMeanRadiusKm;
const moonRadiusForScene = moonMeanRadiusKm / earthMeanRadiusKm;
const siderealLunarMonthDays = 27.321661;
const sceneNorth = new Vector3(0, 1, 0);

const buildMoonOrbitPoints = (date: Date) => {
  const points: Vector3[] = [];
  const samples = 144;

  for (let index = 0; index <= samples; index += 1) {
    const sampleTime = new Date(date.getTime() + (index / samples) * siderealLunarMonthDays * msPerDay);
    points.push(toSceneVector(GeoVector(Body.Moon, sampleTime, true)).multiplyScalar(earthRadiiPerAstronomicalUnit));
  }

  points.push(points[0].clone());
  return points;
};

function CameraRig({moonPosition}: {moonPosition: Vector3}) {
  const {camera} = useThree();

  useEffect(() => {
    const moonDistance = moonPosition.length();
    const moonDirection = moonPosition.clone().normalize();
    const horizontalDirection = new Vector3(moonDirection.x, 0, moonDirection.z);
    const cameraDirection = horizontalDirection.lengthSq() > 0.0001 ? new Vector3(-horizontalDirection.z, 0, horizontalDirection.x).normalize() : new Vector3(0, 0, 1);
    const cameraDistance = Math.max(180, moonDistance * 3.1);

    const cameraPosition = cameraDirection.multiplyScalar(cameraDistance).add(new Vector3(0, moonDistance * 0.12, 0));
    camera.position.copy(cameraPosition);
    camera.lookAt(0, 0, 0);
    camera.updateProjectionMatrix();
  }, [camera, moonPosition]);

  return null;
}

function Earth({orientation}: {orientation: Quaternion}) {
  const [earthTextureMap, specularMap, cloudsTextureMap] = useTexture([earthDayTexture, earthSpecularTexture, earthCloudsTexture]);

  const earthMap = useMemo(() => {
    const map = earthTextureMap.clone();
    map.colorSpace = SRGBColorSpace;
    map.needsUpdate = true;
    return map;
  }, [earthTextureMap]);

  const cloudsMap = useMemo(() => {
    const map = cloudsTextureMap.clone();
    map.colorSpace = SRGBColorSpace;
    map.needsUpdate = true;
    return map;
  }, [cloudsTextureMap]);

  return (
    <group quaternion={orientation}>
      <mesh castShadow receiveShadow>
        <sphereGeometry args={[1, 128, 128]} />
        <meshPhongMaterial map={earthMap} specularMap={specularMap} specular={new Color("#456d8f")} shininess={18} />
      </mesh>
      <mesh>
        <sphereGeometry args={[1.014, 128, 128]} />
        <meshLambertMaterial map={cloudsMap} transparent opacity={0.42} depthWrite={false} />
      </mesh>
      <mesh scale={1.055}>
        <sphereGeometry args={[1, 96, 96]} />
        <meshBasicMaterial color="#63a8ff" transparent opacity={0.16} side={BackSide} blending={AdditiveBlending} depthWrite={false} />
      </mesh>
    </group>
  );
}

function Moon({position}: {position: Vector3}) {
  const moonMap = useTexture(moonTexture);

  const texture = useMemo(() => {
    const map = moonMap.clone();
    map.colorSpace = SRGBColorSpace;
    map.needsUpdate = true;
    return map;
  }, [moonMap]);

  return (
    <mesh position={position} castShadow receiveShadow rotation={[0.12, 0.7, -0.18]}>
      <sphereGeometry args={[moonRadiusForScene, 96, 96]} />
      <meshStandardMaterial map={texture} bumpMap={texture} bumpScale={0.022} roughness={0.92} metalness={0} />
    </mesh>
  );
}

function MoonOrbitPath({points}: {points: Vector3[]}) {
  return <Line points={points} color="#86caff" lineWidth={1.25} transparent opacity={0.42} />;
}

function SunLighting({sunDirection}: {sunDirection: Vector3}) {
  const lightRef = useRef<DirectionalLight | null>(null);
  const lightPosition = sunDirection.clone().multiplyScalar(18);

  useEffect(() => {
    if (!lightRef.current) return;
    lightRef.current.target.position.set(0, 0, 0);
    lightRef.current.target.updateMatrixWorld();
  }, [sunDirection]);

  return (
    <>
      <directionalLight
        ref={lightRef}
        position={lightPosition}
        intensity={5.8}
        color="#fff1d5"
        castShadow
        shadow-mapSize-width={2048}
        shadow-mapSize-height={2048}
        shadow-camera-near={1}
        shadow-camera-far={36}
        shadow-camera-left={-11}
        shadow-camera-right={11}
        shadow-camera-top={11}
        shadow-camera-bottom={-11}
      />
      <ambientLight intensity={0.045} color="#9db8ff" />
    </>
  );
}

function SkyPathChart({
  sunContextPath,
  moonContextPath,
  sunNow,
  moonNow,
  sunLabels,
  moonLabels,
  facingDegrees,
  pointingAltitude,
  zoneId,
  localDayStartUtc,
}: {
  sunContextPath: SkyPoint[];
  moonContextPath: SkyPoint[];
  sunNow: SkyPoint;
  moonNow: SkyPoint;
  sunLabels: HorizonEventLabel;
  moonLabels: HorizonEventLabel;
  facingDegrees: number;
  pointingAltitude: number | null;
  zoneId: string;
  localDayStartUtc: Date;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const staticSceneRef = useRef<StaticSkyScene | null>(null);
  const facingDegreesRef = useRef(facingDegrees);
  const pointingAltitudeRef = useRef(pointingAltitude);
  const pointerRef = useRef<ChartPointer | null>(null);
  const [pointer, setPointer] = useState<ChartPointer | null>(null);
  const [canvasSize, setCanvasSize] = useState({width: 0, height: 0});

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const updateSize = () => {
      const width = Math.round(canvas.clientWidth);
      const height = Math.round(canvas.clientHeight);
      setCanvasSize((current) => (current.width === width && current.height === height ? current : {width, height}));
    };

    updateSize();

    const resizeObserver = new ResizeObserver(updateSize);
    resizeObserver.observe(canvas);

    return () => resizeObserver.disconnect();
  }, []);

  useEffect(() => {
    facingDegreesRef.current = facingDegrees;
    pointingAltitudeRef.current = pointingAltitude;
    pointerRef.current = pointer;

    const canvas = canvasRef.current;
    const scene = staticSceneRef.current;
    if (!canvas || !scene) return;

    drawSkyViewport(canvas, scene, facingDegrees, pointingAltitude, pointer);
  }, [facingDegrees, pointingAltitude, pointer]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const width = Math.round(canvas.clientWidth);
    const height = Math.round(canvas.clientHeight);
    if (width <= 0 || height <= 0) return;

    canvas.width = width;
    canvas.height = height;

    const sceneCanvas = document.createElement("canvas");
    const panoramaWidth = width * 3;
    sceneCanvas.width = panoramaWidth;
    sceneCanvas.height = height;

    const context = sceneCanvas.getContext("2d");
    if (!context) return;

    context.lineCap = "round";
    context.lineJoin = "round";

    const xFromSkyDegrees = (degrees: number) => ((degrees + 360) / 360) * width;
    const yFromAlt = (altitude: number) => height - ((altitude + 90) / 180) * height;
    const horizonY = yFromAlt(0);
    const panoramaOffsets = [-720, -360, 0, 360, 720];
    const sunPath = sunContextPath.map((point) => ({...point}));
    const moonPath = moonContextPath.map((point) => ({...point}));

    context.clearRect(0, 0, panoramaWidth, height);
    context.fillStyle = "#060911";
    context.fillRect(0, 0, panoramaWidth, height);
    context.fillStyle = "#04060c";
    context.fillRect(0, horizonY, panoramaWidth, height - horizonY);

    context.strokeStyle = "#1e2a45";
    context.lineWidth = 1;
    for (let altitude = -60; altitude <= 90; altitude += 30) {
      const y = yFromAlt(altitude);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(panoramaWidth, y);
      context.stroke();
    }

    for (let azimuth = -360; azimuth <= 720; azimuth += 60) {
      const x = xFromSkyDegrees(azimuth);
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    context.strokeStyle = "#e8edf8";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, horizonY);
    context.lineTo(panoramaWidth, horizonY);
    context.stroke();

    type AltitudePathPoint = {x: number; y: number; relativeAzimuth: number};

    const buildAltitudePathCurve = (rawPoints: SkyPoint[], preferNearTimeMs: number | null) => {
      if (rawPoints.length < 2) return null;

      const sampleCount = Math.max(360, Math.round(panoramaWidth / 2));
      const points: AltitudePathPoint[] = [];

      for (let index = 0; index <= sampleCount; index += 1) {
        const x = (index / sampleCount) * panoramaWidth;
        const skyDegrees = (x / width) * 360 - 360;
        const altitude = interpolateAltitudeAtDisplayAzimuth(rawPoints, skyDegrees, preferNearTimeMs);
        points.push({
          x,
          y: altitude === null ? Number.NaN : yFromAlt(altitude),
          relativeAzimuth: skyDegrees,
        });
      }

      return {points};
    };

    const traceAltitudePath = (curve: NonNullable<ReturnType<typeof buildAltitudePathCurve>>) => {
      let previousFinite: AltitudePathPoint | null = null;

      for (const current of curve.points) {
        if (!Number.isFinite(current.y)) {
          if (previousFinite !== null) context.stroke();
          previousFinite = null;
          continue;
        }

        if (previousFinite === null) {
          context.beginPath();
          context.moveTo(current.x, current.y);
        } else {
          context.lineTo(current.x, current.y);
        }

        previousFinite = current;
      }

      if (previousFinite !== null) context.stroke();
    };

    const drawBelowHorizonPath = (curve: NonNullable<ReturnType<typeof buildAltitudePathCurve>>, color: string) => {
      context.save();
      context.beginPath();
      context.rect(0, horizonY, panoramaWidth, height - horizonY);
      context.clip();
      context.strokeStyle = color;
      context.globalAlpha = 0.32;
      context.lineWidth = 1.5;
      context.setLineDash([5, 6]);
      traceAltitudePath(curve);
      context.restore();
    };

    const drawVisiblePath = (curve: NonNullable<ReturnType<typeof buildAltitudePathCurve>>, color: string) => {
      context.save();
      context.beginPath();
      context.rect(0, 0, panoramaWidth, horizonY);
      context.clip();
      context.strokeStyle = color;
      context.globalAlpha = 1;
      context.lineWidth = 2.5;
      context.setLineDash([]);
      traceAltitudePath(curve);
      context.restore();
    };

    const getHorizonCrossings = (points: SkyPoint[], color: string, labels: HorizonEventLabel) => {
      const baseCrossings: Array<Omit<HorizonCrossing, "x" | "y"> & {relativeAzimuth: number}> = [];
      const usedCrossingKeys = new Set<string>();

      const pushCrossing = (relativeAzimuth: number, crossingTimeMs: number | null, isRise: boolean) => {
        const crossingKey = crossingTimeMs === null ? `${Math.round(relativeAzimuth * 1000)}-${isRise ? "rise" : "set"}` : `${Math.round(crossingTimeMs / 1000)}-${isRise ? "rise" : "set"}`;
        if (usedCrossingKeys.has(crossingKey)) return;
        usedCrossingKeys.add(crossingKey);

        const label = crossingTimeMs === null ? (isRise ? labels.rise : labels.set) : `${isRise ? labels.riseName : labels.setName} ${civicEventTimeLabel(new Date(crossingTimeMs), zoneId, localDayStartUtc)}`;
        baseCrossings.push({
          relativeAzimuth,
          color,
          label,
          labelY: horizonY + (isRise ? -10 : 20),
          timeMs: crossingTimeMs,
          isRise,
        });
      };

      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (Math.abs(current.relativeAzimuth - previous.relativeAzimuth) > 180) continue;

        if (Math.abs(current.altitude) < 1e-6) {
          const next = points[index + 1];
          if (!next) {
            if (previous.altitude > 0) pushCrossing(current.relativeAzimuth, current.timeMs ?? null, false);
            else if (previous.altitude < 0) pushCrossing(current.relativeAzimuth, current.timeMs ?? null, true);
            continue;
          }

          if (Math.abs(next.relativeAzimuth - current.relativeAzimuth) > 180) continue;
          if ((previous.altitude < 0 && next.altitude > 0) || (previous.altitude > 0 && next.altitude < 0)) {
            pushCrossing(current.relativeAzimuth, current.timeMs ?? null, previous.altitude < next.altitude);
          }
          continue;
        }

        if (Math.abs(previous.altitude) < 1e-6) continue;
        if (previous.altitude * current.altitude > 0) continue;

        const fractionToHorizon = previous.altitude / (previous.altitude - current.altitude);
        const relativeAzimuth = interpolateWrappedDegrees(previous.relativeAzimuth, current.relativeAzimuth, fractionToHorizon);
        const crossingTimeMs = previous.timeMs !== undefined && current.timeMs !== undefined ? previous.timeMs + (current.timeMs - previous.timeMs) * fractionToHorizon : null;
        pushCrossing(relativeAzimuth, crossingTimeMs, previous.altitude < current.altitude);
      }

      return baseCrossings.flatMap((crossing) =>
        panoramaOffsets.flatMap((degreeOffset) => {
          const x = xFromSkyDegrees(crossing.relativeAzimuth + degreeOffset);
          if (x < -40 || x > panoramaWidth + 40) return [];

          return [
            {
              x,
              y: horizonY,
              color: crossing.color,
              label: crossing.label,
              labelY: crossing.labelY,
              timeMs: crossing.timeMs,
              isRise: crossing.isRise,
            },
          ];
        }),
      );
    };

    const sunCurve = buildAltitudePathCurve(sunPath, sunNow.timeMs ?? null);
    const moonCurve = buildAltitudePathCurve(moonPath, moonNow.timeMs ?? null);
    if (!sunCurve || !moonCurve) return;

    drawBelowHorizonPath(sunCurve, "#f5bf42");
    drawBelowHorizonPath(moonCurve, "#7cc3ff");
    drawVisiblePath(sunCurve, "#f5bf42");
    drawVisiblePath(moonCurve, "#7cc3ff");

    const crossings = [...getHorizonCrossings(sunPath, "#f5bf42", {...sunLabels}), ...getHorizonCrossings(moonPath, "#7cc3ff", {...moonLabels})];
    crossings.forEach(({x, y, color}) => {
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.beginPath();
      context.arc(x, y, 5, 0, Math.PI * 2);
      context.stroke();
    });

    const relativeAzimuthOnPath = (path: SkyPoint[], point: SkyPoint) => {
      if (point.timeMs === undefined) return point.relativeAzimuth;

      let bestAzimuth = path[0]?.relativeAzimuth ?? point.relativeAzimuth;
      let bestDelta = Infinity;
      for (const sample of path) {
        if (sample.timeMs === undefined) continue;
        const delta = Math.abs(sample.timeMs - point.timeMs);
        if (delta < bestDelta) {
          bestDelta = delta;
          bestAzimuth = sample.relativeAzimuth;
        }
      }

      return bestAzimuth;
    };

    const drawNowMarker = (point: SkyPoint, path: SkyPoint[], color: string, radius: number) => {
      const relativeAzimuth = relativeAzimuthOnPath(path, point);
      const y = yFromAlt(point.altitude);
      context.fillStyle = color;
      panoramaOffsets.forEach((degreeOffset) => {
        const skyDegrees = relativeAzimuth + degreeOffset;
        const x = xFromSkyDegrees(skyDegrees);
        if (x < -radius || x > panoramaWidth + radius) return;
        context.beginPath();
        context.arc(x, y, radius, 0, Math.PI * 2);
        context.fill();
      });
    };

    drawNowMarker(sunNow, sunPath, "#ffd15e", 20);
    drawNowMarker(moonNow, moonPath, "#8bc9ff", 10);

    const sunDiskHitRadius = 26;
    const sunHoverLabel = `sun az ${sunNow.azimuth.toFixed(1)}°, alt ${sunNow.altitude.toFixed(1)}°`;
    const diskHovers: SkyDiskHover[] = [];
    panoramaOffsets.forEach((degreeOffset) => {
      const skyDegrees = relativeAzimuthOnPath(sunPath, sunNow) + degreeOffset;
      const x = xFromSkyDegrees(skyDegrees);
      if (x < -sunDiskHitRadius || x > panoramaWidth + sunDiskHitRadius) return;
      const y = yFromAlt(sunNow.altitude);
      diskHovers.push({
        panoramaX: x,
        y,
        label: sunHoverLabel,
        labelY: y - 26,
        hitRadius: sunDiskHitRadius,
      });
    });

    const moonDiskHitRadius = 16;
    const moonHoverLabel = `moon az ${moonNow.azimuth.toFixed(1)}°, alt ${moonNow.altitude.toFixed(1)}°`;
    panoramaOffsets.forEach((degreeOffset) => {
      const skyDegrees = relativeAzimuthOnPath(moonPath, moonNow) + degreeOffset;
      const x = xFromSkyDegrees(skyDegrees);
      if (x < -moonDiskHitRadius || x > panoramaWidth + moonDiskHitRadius) return;
      const y = yFromAlt(moonNow.altitude);
      diskHovers.push({
        panoramaX: x,
        y,
        label: moonHoverLabel,
        labelY: y - 20,
        hitRadius: moonDiskHitRadius,
      });
    });

    const scene = {canvas: sceneCanvas, crossings, diskHovers, width, height};
    staticSceneRef.current = scene;
    drawSkyViewport(canvas, scene, facingDegreesRef.current, pointingAltitudeRef.current, pointerRef.current);
  }, [sunContextPath, moonContextPath, sunNow, moonNow, sunLabels, moonLabels, zoneId, localDayStartUtc, canvasSize]);

  return (
    <canvas
      className="sky-canvas"
      ref={canvasRef}
      onMouseLeave={() => setPointer(null)}
      onMouseMove={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        setPointer({
          x: event.clientX - rect.left,
          y: event.clientY - rect.top,
        });
      }}
    />
  );
}

function MoonPhaseVisual({phaseFraction, waxing}: {phaseFraction: number; waxing: boolean}) {
  const center = 50;
  const radius = 46;
  const phase = Math.max(0, Math.min(1, phaseFraction));
  const newThreshold = 0.015;
  const fullThreshold = 0.985;
  const terminatorX = center + (waxing ? 1 : -1) * radius * (1 - 2 * phase);
  const litPath = (() => {
    if (phase <= newThreshold) return "";
    if (phase >= fullThreshold) return `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center - 0.01} ${center - radius} Z`;

    return waxing
      ? `M ${center} ${center - radius} A ${radius} ${radius} 0 0 1 ${center} ${center + radius} Q ${terminatorX} ${center} ${center} ${center - radius} Z`
      : `M ${center} ${center - radius} Q ${terminatorX} ${center} ${center} ${center + radius} A ${radius} ${radius} 0 0 1 ${center} ${center - radius} Z`;
  })();

  return (
    <svg className="moon-phase-visual" viewBox="0 0 100 100" role="img" aria-label={`Moon ${Math.round(phaseFraction * 100)}% illuminated`}>
      <defs>
        <clipPath id="moon-disc">
          <circle cx="50" cy="50" r="46" />
        </clipPath>
        <linearGradient id="moon-surface" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stopColor="#f5f7fb" />
          <stop offset="100%" stopColor="#aeb7c8" />
        </linearGradient>
      </defs>
      <circle cx={center} cy={center} r={radius} fill="#202838" />
      {litPath && <path d={litPath} fill="url(#moon-surface)" clipPath="url(#moon-disc)" />}
      <circle cx="50" cy="50" r="46" fill="none" stroke="#d9e2f2" strokeWidth="2" opacity="0.7" />
      <circle cx="35" cy="34" r="4" fill="#7f8898" opacity="0.28" />
      <circle cx="62" cy="58" r="6" fill="#7f8898" opacity="0.22" />
      <circle cx="45" cy="70" r="3" fill="#7f8898" opacity="0.24" />
    </svg>
  );
}

function DayNightTerminatorOverlay({subsolarPoint}: {subsolarPoint: SubsolarPoint}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const drawOverlay = () => {
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(canvas.clientWidth * pixelRatio));
      const height = Math.max(1, Math.round(canvas.clientHeight * pixelRatio));
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) return;

      const imageData = context.createImageData(width, height);
      const data = imageData.data;
      const subsolarLatitude = subsolarPoint.latitude * DEG2RAD;
      const subsolarLongitude = subsolarPoint.longitude * DEG2RAD;
      const subsolarSin = Math.sin(subsolarLatitude);
      const subsolarCos = Math.cos(subsolarLatitude);
      const twilightDepth = Math.sin(18 * DEG2RAD);
      const daylightFeather = 0.025;
      const maxNightAlpha = 216;

      for (let y = 0; y < height; y += 1) {
        const latitude = (90 - (y / Math.max(1, height - 1)) * 180) * DEG2RAD;
        const latitudeSin = Math.sin(latitude);
        const latitudeCos = Math.cos(latitude);

        for (let x = 0; x < width; x += 1) {
          const longitude = (-180 + (x / Math.max(1, width - 1)) * 360) * DEG2RAD;
          const cosSolarZenith = latitudeSin * subsolarSin + latitudeCos * subsolarCos * Math.cos(longitude - subsolarLongitude);
          const nightProgress = Math.min(1, Math.max(0, (daylightFeather - cosSolarZenith) / (daylightFeather + twilightDepth)));
          const index = (y * width + x) * 4;
          const twilightGlow = Math.max(0, 1 - Math.abs(nightProgress - 0.34) / 0.34);

          data[index] = 2 + Math.round(twilightGlow * 18);
          data[index + 1] = 7 + Math.round(twilightGlow * 30);
          data[index + 2] = 18 + Math.round(twilightGlow * 66);
          data[index + 3] = Math.round(maxNightAlpha * nightProgress ** 0.74);
        }
      }

      context.putImageData(imageData, 0, 0);
    };

    drawOverlay();

    const resizeObserver = new ResizeObserver(drawOverlay);
    resizeObserver.observe(canvas);

    return () => resizeObserver.disconnect();
  }, [subsolarPoint.latitude, subsolarPoint.longitude]);

  return <canvas className="earth-day-night-overlay" ref={canvasRef} aria-hidden="true" />;
}

function OrbitView({earthOrientation, moonPosition, moonOrbitPoints, sunDirection}: {earthOrientation: Quaternion; moonPosition: Vector3; moonOrbitPoints: Vector3[]; sunDirection: Vector3}) {
  return (
    <div className="orbit-canvas-wrap">
      <Canvas shadows="percentage" camera={{position: [0, 8, 190], fov: 42, near: 0.1, far: 500}} gl={{antialias: true}}>
        <color attach="background" args={["#02040a"]} />
        <fog attach="fog" args={["#02040a", 140, 260]} />
        <Stars radius={220} depth={140} count={5200} factor={3.8} saturation={0} fade speed={0.18} />
        <CameraRig moonPosition={moonPosition} />
        <SunLighting sunDirection={sunDirection} />
        <Earth orientation={earthOrientation} />
        <MoonOrbitPath points={moonOrbitPoints} />
        <Moon position={moonPosition} />
        <OrbitControls target={[0, 0, 0]} enablePan={false} minDistance={18} maxDistance={240} enableDamping dampingFactor={0.06} rotateSpeed={0.62} />
      </Canvas>
    </div>
  );
}

function App() {
  const [simTimeMs, setSimTimeMs] = useState(() => Date.now());
  const [latitude, setLatitude] = useState(35.687);
  const [longitude, setLongitude] = useState(-105.9378);
  const [facingDegrees, setFacingDegrees] = useState(180);
  const [activeView, setActiveView] = useState<"sky" | "orbit">("sky");
  const {
    compassState,
    start: startCompass,
    stop: stopCompass,
    isActive: compassActive,
    pointingAltitude,
  } = useDeviceHeading({
    latitude,
    longitude,
    onHeading: setFacingDegrees,
  });

  const zoneId = useMemo(() => observingTimeZone(latitude, longitude), [latitude, longitude]);
  const dtLocal = useMemo(() => DateTime.fromMillis(simTimeMs, {zone: "utc"}).setZone(zoneId), [simTimeMs, zoneId]);
  const dtUtc = useMemo(() => DateTime.fromMillis(simTimeMs, {zone: "utc"}), [simTimeMs]);

  const year = dtLocal.year;
  const month = dtLocal.month;
  const day = dtLocal.day;
  const minutesLocal = dtLocal.hour * 60 + dtLocal.minute;

  const observer = useMemo(() => new Observer(latitude, longitude, 0), [latitude, longitude]);

  const currentTime = useMemo(() => new Date(simTimeMs), [simTimeMs]);

  const localDayStartUtc = useMemo(() => {
    return DateTime.fromMillis(simTimeMs, {zone: "utc"}).setZone(zoneId).startOf("day").toUTC().toJSDate();
  }, [simTimeMs, zoneId]);

  const dayTracks = useMemo(() => {
    return {
      sunContextPath: buildDisplayPath(Body.Sun, observer, currentTime, localDayStartUtc, 0),
      moonContextPath: buildDisplayPath(Body.Moon, observer, currentTime, localDayStartUtc, 0),
    };
  }, [currentTime, localDayStartUtc, observer]);

  const currentSky = useMemo(() => {
    const sunHorizontal = bodyHorizontal(Body.Sun, currentTime, observer);
    const moonHorizontal = bodyHorizontal(Body.Moon, currentTime, observer);

    return {
      sunNow: {
        azimuth: sunHorizontal.azimuth,
        altitude: sunHorizontal.altitude,
        relativeAzimuth: normalizeSignedDegrees(sunHorizontal.azimuth),
        timeMs: currentTime.getTime(),
      },
      moonNow: {
        azimuth: moonHorizontal.azimuth,
        altitude: moonHorizontal.altitude,
        relativeAzimuth: normalizeSignedDegrees(moonHorizontal.azimuth),
        timeMs: currentTime.getTime(),
      },
    };
  }, [currentTime, observer]);

  const orbitalState = useMemo(() => {
    const sunGeo = GeoVector(Body.Sun, currentTime, true);
    const moonGeo = GeoVector(Body.Moon, currentTime, true);
    const sunDirection = toSceneVector(sunGeo).normalize();
    const moonPosition = toSceneVector(moonGeo).multiplyScalar(earthRadiiPerAstronomicalUnit);
    const moonOrbitPoints = buildMoonOrbitPoints(currentTime);
    const subsolarPoint = getSubsolarPoint(currentTime);
    const subsolarLongitude = normalizeDegrees(subsolarPoint.longitude);
    const subsolarLatitude = subsolarPoint.latitude;
    const longitudeRadians = subsolarLongitude * DEG2RAD;
    const latitudeRadians = subsolarLatitude * DEG2RAD;
    const subsolarLocal = new Vector3(Math.cos(latitudeRadians) * Math.cos(longitudeRadians), Math.sin(latitudeRadians), -Math.cos(latitudeRadians) * Math.sin(longitudeRadians)).normalize();
    const localNorth = new Vector3(-Math.sin(latitudeRadians) * Math.cos(longitudeRadians), Math.cos(latitudeRadians), Math.sin(latitudeRadians) * Math.sin(longitudeRadians)).normalize();
    const localEast = new Vector3(-Math.sin(longitudeRadians), 0, -Math.cos(longitudeRadians)).normalize();
    const targetNorth = sceneNorth
      .clone()
      .sub(sunDirection.clone().multiplyScalar(sceneNorth.dot(sunDirection)))
      .normalize();
    const targetEast = targetNorth.clone().cross(sunDirection).normalize();
    const localBasis = new Matrix4().makeBasis(localEast, localNorth, subsolarLocal);
    const targetBasis = new Matrix4().makeBasis(targetEast, targetNorth, sunDirection);
    const earthOrientation = new Quaternion().setFromRotationMatrix(targetBasis.multiply(localBasis.invert()));

    return {
      earthOrientation,
      moonPosition,
      moonOrbitPoints,
      sunDirection,
      subsolarPoint,
    };
  }, [currentTime]);

  const localAlmanac = useMemo(() => {
    const sunRise = SearchRiseSet(Body.Sun, observer, 1, localDayStartUtc, 1)?.date ?? null;
    const sunSet = SearchRiseSet(Body.Sun, observer, -1, localDayStartUtc, 1)?.date ?? null;
    const moonRise = SearchRiseSet(Body.Moon, observer, 1, localDayStartUtc, 1)?.date ?? null;
    const moonSet = SearchRiseSet(Body.Moon, observer, -1, localDayStartUtc, 1)?.date ?? null;
    const moonPhaseDegrees = MoonPhase(currentTime);
    const moonIllumination = Illumination(Body.Moon, currentTime);
    const nextNewMoon = nextPhaseTime(0, currentTime);
    const nextFullMoon = nextPhaseTime(180, currentTime);

    return {
      sunRise,
      sunSet,
      moonRise,
      moonSet,
      moonPhaseDegrees,
      moonPhaseName: toMoonPhaseName(moonPhaseDegrees),
      moonTrend: toMoonTrend(moonPhaseDegrees),
      moonPhaseFraction: moonIllumination.phase_fraction,
      nextNewMoon,
      nextFullMoon,
    };
  }, [currentTime, localDayStartUtc, observer]);

  const chartEventLabels = useMemo(() => {
    return {
      sun: {
        rise: `sunrise ${civicEventTimeLabel(localAlmanac.sunRise, zoneId, localDayStartUtc)}`,
        set: `sunset ${civicEventTimeLabel(localAlmanac.sunSet, zoneId, localDayStartUtc)}`,
        riseName: "sunrise",
        setName: "sunset",
      },
      moon: {
        rise: `moonrise ${civicEventTimeLabel(localAlmanac.moonRise, zoneId, localDayStartUtc)}`,
        set: `moonset ${civicEventTimeLabel(localAlmanac.moonSet, zoneId, localDayStartUtc)}`,
        riseName: "moonrise",
        setName: "moonset",
      },
    };
  }, [localAlmanac, zoneId, localDayStartUtc]);

  const pinLeft = `${((longitude + 180) / 360) * 100}%`;
  const pinTop = `${((90 - latitude) / 180) * 100}%`;

  return (
    <div className={`app-shell ${activeView === "orbit" ? "orbit-mode" : ""}`}>
      <header className="app-header">
        <div className="flex min-w-0 flex-1 flex-row flex-wrap items-center gap-x-4 gap-y-1">
          <h1 className="shrink-0 text-xl">Sun • Earth • Moon</h1>
          <time className="min-w-0 text-sm font-medium tracking-tight text-muted-foreground tabular-nums md:text-base" dateTime={dtLocal.toISO() ?? undefined} title={dtLocal.toFormat("cccc, d LLLL yyyy, HH:mm:ss ZZZZ")}>
            {dtLocal.toFormat("yyyy/MM/dd HH:mm")}
          </time>
        </div>
        <nav className="view-toggle flex flex-wrap gap-1 p-1" aria-label="View mode">
          <Button type="button" className="min-w-[7.25rem] whitespace-nowrap" size="sm" variant={activeView === "sky" ? "default" : "outline"} onClick={() => setActiveView("sky")}>
            Sky paths
          </Button>
          <Button type="button" className="min-w-[7.25rem] whitespace-nowrap" size="sm" variant={activeView === "orbit" ? "default" : "outline"} onClick={() => setActiveView("orbit")}>
            Earth & Moon
          </Button>
        </nav>
      </header>

      {activeView === "sky" ? (
        <>
          <section className="panel">
            <SkyPathChart
              sunContextPath={dayTracks.sunContextPath}
              moonContextPath={dayTracks.moonContextPath}
              sunNow={currentSky.sunNow}
              moonNow={currentSky.moonNow}
              sunLabels={chartEventLabels.sun}
              moonLabels={chartEventLabels.moon}
              facingDegrees={facingDegrees}
              pointingAltitude={compassActive ? pointingAltitude : null}
              zoneId={zoneId}
              localDayStartUtc={localDayStartUtc}
            />
            <div className="readout readout-sky-footer">
              <div className="readout-facing field-stack my-8">
                <Slider
                  id="facing-slider"
                  min={0}
                  max={359}
                  step={1}
                  value={[facingDegrees]}
                  onValueChange={(values) => {
                    if (compassActive) stopCompass();
                    setFacingDegrees(values[0] ?? 0);
                  }}
                />
                <Label htmlFor="facing-slider" className="mt-4 w-full justify-center text-center">
                  Facing {Math.round(facingDegrees)}° • {toCompassDirection(facingDegrees)}
                </Label>
                <div className="compass-control" aria-live="polite">
                  {compassActive ? (
                    <Button type="button" variant="outline" size="sm" className="gap-2" onClick={stopCompass}>
                      <Square className="size-4" aria-hidden="true" />
                      Stop
                    </Button>
                  ) : (
                    <Button type="button" variant="outline" size="sm" className="gap-2" disabled={compassState.status === "requesting"} onClick={startCompass}>
                      <Compass className="size-4" aria-hidden="true" />
                      Use iPhone Compass
                    </Button>
                  )}
                  <p className="compass-status text-muted-foreground">{compassMessage(compassState)}</p>
                </div>
              </div>
            </div>
          </section>

          <div className="sky-controls-row">
            <section className="controls-grid">
              <div className="col-span-full flex min-w-0 flex-col gap-6">
                <div className="grid min-w-0 grid-cols-3 gap-2">
                  <div className="field-stack">
                    <Label htmlFor="sim-year">Year</Label>
                    <Input
                      id="sim-year"
                      type="number"
                      min={1}
                      max={9999}
                      value={year}
                      onChange={(event) => setSimTimeMs(civicInstantMillis(zoneId, simTimeMs, {year: Number(event.target.value)}))}
                    />
                  </div>
                  <div className="field-stack">
                    <Label htmlFor="sim-month">Month</Label>
                    <Input
                      id="sim-month"
                      type="number"
                      inputMode="numeric"
                      value={month}
                      onChange={(event) => {
                        const raw = event.target.value;
                        if (raw === "" || raw === "-" || raw === "+") return;
                        const n = Number(raw);
                        if (!Number.isFinite(n)) return;
                        setSimTimeMs(civicSetMonthOrDayMillis(zoneId, simTimeMs, {month: n}));
                      }}
                    />
                  </div>
                  <div className="field-stack">
                    <Label htmlFor="sim-day">Day</Label>
                    <Input
                      id="sim-day"
                      type="number"
                      inputMode="numeric"
                      value={day}
                      onChange={(event) => {
                        const raw = event.target.value;
                        if (raw === "" || raw === "-" || raw === "+") return;
                        const n = Number(raw);
                        if (!Number.isFinite(n)) return;
                        setSimTimeMs(civicSetMonthOrDayMillis(zoneId, simTimeMs, {day: n}));
                      }}
                    />
                  </div>
                </div>
                <div className="field-stack min-w-0">
                  <Label htmlFor="sim-time-slider">Time of day</Label>
                  <Slider
                    id="sim-time-slider"
                    min={0}
                    max={24 * 60 - 1}
                    step={1}
                    value={[minutesLocal]}
                    onValueChange={(values) => {
                      const mins = values[0] ?? 0;
                      setSimTimeMs(civicInstantMillis(zoneId, simTimeMs, {hour: Math.floor(mins / 60), minute: mins % 60}));
                    }}
                  />
                  <span className="time-readout text-muted-foreground">
                    {dtLocal.toFormat("HH:mm")} {dtLocal.toFormat("z")} • {dtUtc.toFormat("HH:mm")} UTC
                  </span>
                </div>
                <div className="flex justify-end">
                  <Button type="button" variant="outline" size="sm" className="whitespace-nowrap" onClick={() => setSimTimeMs(Date.now())}>
                    Current Time
                  </Button>
                </div>
              </div>
              <section className="local-almanac" aria-label="Local sun and moon almanac">
                <div className="almanac-times">
                  <div>
                    <span>Sunrise</span>
                    <strong>{civicEventTimeLabel(localAlmanac.sunRise, zoneId, localDayStartUtc)}</strong>
                  </div>
                  <div>
                    <span>Sunset</span>
                    <strong>{civicEventTimeLabel(localAlmanac.sunSet, zoneId, localDayStartUtc)}</strong>
                  </div>
                  <div>
                    <span>Moonrise</span>
                    <strong>{civicEventTimeLabel(localAlmanac.moonRise, zoneId, localDayStartUtc)}</strong>
                  </div>
                  <div>
                    <span>Moonset</span>
                    <strong>{civicEventTimeLabel(localAlmanac.moonSet, zoneId, localDayStartUtc)}</strong>
                  </div>
                </div>
                <div className="moon-phase-card">
                  <MoonPhaseVisual phaseFraction={localAlmanac.moonPhaseFraction} waxing={localAlmanac.moonPhaseDegrees < 180} />
                  <div>
                    <h3>{localAlmanac.moonPhaseName}</h3>
                    <p>
                      {Math.round(localAlmanac.moonPhaseFraction * 100)}% illuminated, {localAlmanac.moonTrend}
                    </p>
                    <p>
                      New in {toDurationLabel(currentTime, localAlmanac.nextNewMoon)} • Full in {toDurationLabel(currentTime, localAlmanac.nextFullMoon)}
                    </p>
                  </div>
                </div>
              </section>
            </section>

            <section className="pin-panel">
              <h2>Earth pin placement</h2>
              <p className="pin-zone-id">{zoneId}</p>
              <div
                className="earth-map"
                style={{backgroundImage: `url(${worldMapTexture})`}}
                onClick={(event) => {
                  const rect = event.currentTarget.getBoundingClientRect();
                  const x = event.clientX - rect.left;
                  const y = event.clientY - rect.top;
                  const nextLon = (x / rect.width) * 360 - 180;
                  const nextLat = 90 - (y / rect.height) * 180;
                  setLongitude(Number(nextLon.toFixed(4)));
                  setLatitude(Number(nextLat.toFixed(4)));
                }}
                role="button"
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.click();
                }}>
                <DayNightTerminatorOverlay subsolarPoint={orbitalState.subsolarPoint} />
                <div className="earth-pin" style={{left: pinLeft, top: pinTop}} />
              </div>
              <p className="day-night-caption">
                Day/night at selected time • subsolar point {orbitalState.subsolarPoint.latitude.toFixed(1)}°, {orbitalState.subsolarPoint.longitude.toFixed(1)}°
              </p>
              <div className="pin-panel-controls">
                <div className="field-stack">
                  <Label htmlFor="pin-latitude">Latitude</Label>
                  <Input id="pin-latitude" type="number" step={0.0001} min={-90} max={90} value={latitude} onChange={(event) => setLatitude(Number(event.target.value))} />
                </div>
                <div className="field-stack">
                  <Label htmlFor="pin-longitude">Longitude</Label>
                  <Input id="pin-longitude" type="number" step={0.0001} min={-180} max={180} value={longitude} onChange={(event) => setLongitude(Number(event.target.value))} />
                </div>
              </div>
            </section>
          </div>
        </>
      ) : (
        <main className="orbit-stage">
          <OrbitView earthOrientation={orbitalState.earthOrientation} moonPosition={orbitalState.moonPosition} moonOrbitPoints={orbitalState.moonOrbitPoints} sunDirection={orbitalState.sunDirection} />
        </main>
      )}
    </div>
  );
}

export default App;
