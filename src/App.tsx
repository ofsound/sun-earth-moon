import {useEffect, useMemo, useRef, useState} from "react";
import {Canvas, useThree} from "@react-three/fiber";
import {OrbitControls, Stars, useTexture} from "@react-three/drei";
import {Body, DEG2RAD, Equator, EquatorFromVector, GeoVector, Horizon, Illumination, MoonPhase, Observer, SearchMoonPhase, SearchRiseSet, SiderealTime} from "astronomy-engine";
import {AdditiveBlending, BackSide, Color, DirectionalLight, Matrix4, Quaternion, SRGBColorSpace, Vector3} from "three";
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
};

type Vec3 = {
  x: number;
  y: number;
  z: number;
};

const minutesPerDay = 24 * 60;
const msPerMinute = 60 * 1000;
const msPerHour = 60 * msPerMinute;
const msPerDay = 24 * msPerHour;

const normalizeSignedDegrees = (degrees: number) => {
  let value = degrees;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
};

const toClockLabel = (minutes: number) => {
  const wrappedMinutes = ((Math.round(minutes) % minutesPerDay) + minutesPerDay) % minutesPerDay;
  const hours = Math.floor(wrappedMinutes / 60);
  const mins = wrappedMinutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")}`;
};

const toUtcMinutesLabel = (minutes: number) => `${toClockLabel(minutes)} UTC`;

const toLocalSolarTimeLabel = (minutesUtc: number, longitude: number) => {
  const localMinutes = minutesUtc + longitude * 4;
  const dayOffset = Math.floor(localMinutes / minutesPerDay);
  const suffix = dayOffset < 0 ? " previous day" : dayOffset > 0 ? " next day" : "";
  return `${toClockLabel(localMinutes)} local solar time${suffix}`;
};

const localSolarMidnightUtc = (year: number, month: number, day: number, longitude: number) => new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0) - longitude * 4 * msPerMinute);

const toDateFromUtcParts = (year: number, month: number, day: number, minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return new Date(Date.UTC(year, month - 1, day, hours, mins, 0, 0));
};

const toLocalSolarEventLabel = (date: Date | null, localDayStartUtc: Date) => {
  if (!date) return "No event";

  const localMinutes = (date.getTime() - localDayStartUtc.getTime()) / msPerMinute;
  const dayOffset = Math.floor(localMinutes / minutesPerDay);
  const suffix = dayOffset < 0 ? " prev day" : dayOffset > 0 ? " next day" : "";
  return `${toClockLabel(localMinutes)}${suffix}`;
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

const withHorizonCrossings = (points: SkyPoint[]) => {
  const result: SkyPoint[] = [];

  points.forEach((point, index) => {
    const previous = points[index - 1];

    if (previous && Math.abs(point.relativeAzimuth - previous.relativeAzimuth) <= 180 && previous.altitude !== point.altitude) {
      const crossesHorizon = (previous.altitude < 0 && point.altitude > 0) || (previous.altitude > 0 && point.altitude < 0);

      if (crossesHorizon) {
        const fractionToHorizon = previous.altitude / (previous.altitude - point.altitude);
        result.push({
          azimuth: previous.azimuth + (point.azimuth - previous.azimuth) * fractionToHorizon,
          altitude: 0,
          relativeAzimuth: previous.relativeAzimuth + (point.relativeAzimuth - previous.relativeAzimuth) * fractionToHorizon,
        });
      }
    }

    result.push(point);
  });

  return result;
};

const buildVisiblePassPath = (body: Body, observer: Observer, start: Date, facingDegrees: number) => {
  const rise = SearchRiseSet(body, observer, 1, start, 1)?.date ?? null;
  if (!rise) return [];

  const set = SearchRiseSet(body, observer, -1, rise, 2)?.date ?? null;
  if (!set) return [];

  const points: SkyPoint[] = [];
  const durationMinutes = Math.max(0, Math.ceil((set.getTime() - rise.getTime()) / msPerMinute));

  for (let minute = 0; minute <= durationMinutes; minute += 5) {
    const sampleTime = new Date(rise.getTime() + minute * msPerMinute);
    const horizontal = bodyHorizontal(body, sampleTime, observer);
    points.push({
      azimuth: horizontal.azimuth,
      altitude: horizontal.altitude,
      relativeAzimuth: normalizeSignedDegrees(horizontal.azimuth - facingDegrees),
    });
  }

  const finalHorizontal = bodyHorizontal(body, set, observer);
  points.push({
    azimuth: finalHorizontal.azimuth,
    altitude: finalHorizontal.altitude,
    relativeAzimuth: normalizeSignedDegrees(finalHorizontal.azimuth - facingDegrees),
  });

  return points;
};

const buildLocalDayPath = (body: Body, observer: Observer, start: Date, facingDegrees: number) => {
  const points: SkyPoint[] = [];

  for (let minute = 0; minute <= minutesPerDay; minute += 5) {
    const sampleTime = new Date(start.getTime() + minute * msPerMinute);
    const horizontal = bodyHorizontal(body, sampleTime, observer);
    points.push({
      azimuth: horizontal.azimuth,
      altitude: horizontal.altitude,
      relativeAzimuth: normalizeSignedDegrees(horizontal.azimuth - facingDegrees),
    });
  }

  return points;
};

const toSceneVector = (vector: Vec3) => new Vector3(vector.x, vector.z, vector.y);
const normalizeDegrees = (degrees: number) => ((degrees % 360) + 360) % 360;

const toCompassDirection = (degrees: number) => {
  const directions = ["North", "North-northeast", "Northeast", "East-northeast", "East", "East-southeast", "Southeast", "South-southeast", "South", "South-southwest", "Southwest", "West-southwest", "West", "West-northwest", "Northwest", "North-northwest"];
  const index = Math.round(normalizeDegrees(degrees) / 22.5) % directions.length;
  return directions[index];
};

const moonDistanceForScene = 2.8;
const moonRadiusForScene = 0.27;
const sceneNorth = new Vector3(0, 1, 0);

function CameraRig({moonPosition}: {moonPosition: Vector3}) {
  const {camera} = useThree();

  useEffect(() => {
    const moonDirection = moonPosition.clone().normalize();
    const horizontalDirection = new Vector3(moonDirection.x, 0, moonDirection.z);
    const cameraDirection = horizontalDirection.lengthSq() > 0.0001 ? new Vector3(-horizontalDirection.z, 0, horizontalDirection.x).normalize() : new Vector3(0, 0, 1);

    const cameraPosition = cameraDirection.multiplyScalar(7.2);
    camera.position.set(cameraPosition.x, 2.35 + moonDirection.y * 0.45, cameraPosition.z);
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

function SkyPathChart({sunPath, moonPath, sunContextPath, moonContextPath, sunNow, moonNow}: {sunPath: SkyPoint[]; moonPath: SkyPoint[]; sunContextPath: SkyPoint[]; moonContextPath: SkyPoint[]; sunNow: SkyPoint; moonNow: SkyPoint}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    canvas.width = width;
    canvas.height = height;
    context.lineCap = "round";
    context.lineJoin = "round";

    const xFromAz = (relativeAzimuth: number) => ((relativeAzimuth + 180) / 360) * width;
    const yFromAlt = (altitude: number) => height - ((altitude + 90) / 180) * height;
    const horizonY = yFromAlt(0);

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#060911";
    context.fillRect(0, 0, width, height);
    context.fillStyle = "#04060c";
    context.fillRect(0, horizonY, width, height - horizonY);

    context.strokeStyle = "#1e2a45";
    context.lineWidth = 1;
    for (let altitude = -60; altitude <= 90; altitude += 30) {
      const y = yFromAlt(altitude);
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }

    for (let azimuth = -180; azimuth <= 180; azimuth += 60) {
      const x = xFromAz(azimuth);
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x, height);
      context.stroke();
    }

    context.strokeStyle = "#e8edf8";
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, horizonY);
    context.lineTo(width, horizonY);
    context.stroke();

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
      const x = xFromAz(azimuth);
      const textWidth = context.measureText(label).width;
      context.fillText(label, Math.min(width - textWidth - 6, Math.max(6, x - textWidth / 2)), height - 10);
    });

    const tracePath = (points: SkyPoint[]) => {
      let hasActivePath = false;
      context.beginPath();

      points.forEach((point, index) => {
        const previous = points[index - 1];
        const x = xFromAz(point.relativeAzimuth);
        const y = yFromAlt(point.altitude);

        if (!previous || Math.abs(point.relativeAzimuth - previous.relativeAzimuth) > 180 || !hasActivePath) {
          context.moveTo(x, y);
          hasActivePath = true;
          return;
        }

        context.lineTo(x, y);
      });
    };

    const drawBelowHorizonPath = (rawPoints: SkyPoint[], color: string) => {
      const points = withHorizonCrossings(rawPoints);

      context.save();
      context.beginPath();
      context.rect(0, horizonY, width, height - horizonY);
      context.clip();
      context.strokeStyle = color;
      context.globalAlpha = 0.32;
      context.lineWidth = 1.5;
      context.setLineDash([5, 6]);
      tracePath(points);
      context.stroke();
      context.restore();
    };

    const drawVisiblePath = (rawPoints: SkyPoint[], color: string) => {
      const points = withHorizonCrossings(rawPoints);
      context.strokeStyle = color;
      context.globalAlpha = 1;
      context.lineWidth = 2.5;
      context.setLineDash([]);
      tracePath(points);
      context.stroke();
      context.globalAlpha = 1;
    };

    drawBelowHorizonPath(sunContextPath, "#f5bf42");
    drawBelowHorizonPath(moonContextPath, "#7cc3ff");
    drawVisiblePath(sunPath, "#f5bf42");
    drawVisiblePath(moonPath, "#7cc3ff");

    const drawHorizonCrossings = (points: SkyPoint[], color: string, labels: [string, string]) => {
      let crossingIndex = 0;
      for (let index = 1; index < points.length; index += 1) {
        const previous = points[index - 1];
        const current = points[index];
        if (Math.abs(current.relativeAzimuth - previous.relativeAzimuth) > 180) continue;
        if ((previous.altitude < 0 && current.altitude < 0) || (previous.altitude > 0 && current.altitude > 0)) continue;

        const fractionToHorizon = previous.altitude / (previous.altitude - current.altitude);
        const relativeAzimuth = previous.relativeAzimuth + (current.relativeAzimuth - previous.relativeAzimuth) * fractionToHorizon;
        const x = xFromAz(relativeAzimuth);
        const label = previous.altitude < current.altitude ? labels[0] : labels[1];

        context.fillStyle = "#060911";
        context.strokeStyle = color;
        context.lineWidth = 2;
        context.beginPath();
        context.arc(x, horizonY, 5, 0, Math.PI * 2);
        context.fill();
        context.stroke();

        context.fillStyle = "#e7edf6";
        context.font = "12px system-ui";
        const offset = crossingIndex % 2 === 0 ? -10 : 20;
        context.fillText(label, Math.min(width - 48, Math.max(6, x + 8)), horizonY + offset);
        crossingIndex += 1;
      }
    };

    drawHorizonCrossings(sunPath, "#f5bf42", ["sunrise", "sunset"]);
    drawHorizonCrossings(moonPath, "#7cc3ff", ["moonrise", "moonset"]);

    const drawNowMarker = (point: SkyPoint, color: string, radius: number) => {
      const x = xFromAz(point.relativeAzimuth);
      const y = yFromAlt(point.altitude);
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };

    drawNowMarker(sunNow, "#ffd15e", 20);
    drawNowMarker(moonNow, "#8bc9ff", 10);
  }, [sunPath, moonPath, sunContextPath, moonContextPath, sunNow, moonNow]);

  return <canvas className="sky-canvas" ref={canvasRef} />;
}

function MoonPhaseVisual({phaseFraction, waxing}: {phaseFraction: number; waxing: boolean}) {
  const clipWidth = Math.max(1, Math.min(99, phaseFraction * 100));
  const clipX = waxing ? 100 - clipWidth : 0;

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
      <circle cx="50" cy="50" r="46" fill="#202838" />
      <rect x={clipX} y="4" width={clipWidth} height="92" fill="url(#moon-surface)" clipPath="url(#moon-disc)" />
      <circle cx="50" cy="50" r="46" fill="none" stroke="#d9e2f2" strokeWidth="2" opacity="0.7" />
      <circle cx="35" cy="34" r="4" fill="#7f8898" opacity="0.28" />
      <circle cx="62" cy="58" r="6" fill="#7f8898" opacity="0.22" />
      <circle cx="45" cy="70" r="3" fill="#7f8898" opacity="0.24" />
    </svg>
  );
}

function OrbitView({earthOrientation, moonPosition, sunDirection}: {earthOrientation: Quaternion; moonPosition: Vector3; sunDirection: Vector3}) {
  return (
    <div className="orbit-canvas-wrap">
      <Canvas shadows="percentage" camera={{position: [0, 2.25, 7.2], fov: 56}} gl={{antialias: true}}>
        <color attach="background" args={["#02040a"]} />
        <fog attach="fog" args={["#02040a", 13, 28]} />
        <Stars radius={120} depth={90} count={5200} factor={3.8} saturation={0} fade speed={0.18} />
        <CameraRig moonPosition={moonPosition} />
        <SunLighting sunDirection={sunDirection} />
        <Earth orientation={earthOrientation} />
        <Moon position={moonPosition} />
        <OrbitControls target={[0, 0, 0]} enablePan={false} minDistance={2.2} maxDistance={18} enableDamping dampingFactor={0.06} rotateSpeed={0.62} />
      </Canvas>
    </div>
  );
}

function App() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [month, setMonth] = useState(now.getUTCMonth() + 1);
  const [day, setDay] = useState(now.getUTCDate());
  const [minutesUtc, setMinutesUtc] = useState(now.getUTCHours() * 60 + now.getUTCMinutes());
  const [latitude, setLatitude] = useState(40.7128);
  const [longitude, setLongitude] = useState(-74.006);
  const [facingDegrees, setFacingDegrees] = useState(180);
  const [activeView, setActiveView] = useState<"sky" | "orbit">("sky");

  const observer = useMemo(() => new Observer(latitude, longitude, 0), [latitude, longitude]);

  const currentTime = useMemo(() => toDateFromUtcParts(year, month, day, minutesUtc), [year, month, day, minutesUtc]);

  const localDayStartUtc = useMemo(() => localSolarMidnightUtc(year, month, day, longitude), [year, month, day, longitude]);

  const dayTracks = useMemo(() => {
    return {
      sunPath: buildVisiblePassPath(Body.Sun, observer, localDayStartUtc, facingDegrees),
      moonPath: buildVisiblePassPath(Body.Moon, observer, localDayStartUtc, facingDegrees),
      sunContextPath: buildLocalDayPath(Body.Sun, observer, localDayStartUtc, facingDegrees),
      moonContextPath: buildLocalDayPath(Body.Moon, observer, localDayStartUtc, facingDegrees),
    };
  }, [localDayStartUtc, observer, facingDegrees]);

  const currentSky = useMemo(() => {
    const sunHorizontal = bodyHorizontal(Body.Sun, currentTime, observer);
    const moonHorizontal = bodyHorizontal(Body.Moon, currentTime, observer);

    return {
      sunNow: {
        azimuth: sunHorizontal.azimuth,
        altitude: sunHorizontal.altitude,
        relativeAzimuth: normalizeSignedDegrees(sunHorizontal.azimuth - facingDegrees),
      },
      moonNow: {
        azimuth: moonHorizontal.azimuth,
        altitude: moonHorizontal.altitude,
        relativeAzimuth: normalizeSignedDegrees(moonHorizontal.azimuth - facingDegrees),
      },
    };
  }, [currentTime, observer, facingDegrees]);

  const orbitalState = useMemo(() => {
    const sunGeo = GeoVector(Body.Sun, currentTime, true);
    const moonGeo = GeoVector(Body.Moon, currentTime, true);
    const sunDirection = toSceneVector(sunGeo).normalize();
    const moonPosition = toSceneVector(moonGeo).normalize().multiplyScalar(moonDistanceForScene);
    const sunEquator = EquatorFromVector(sunGeo);
    const subsolarLongitude = normalizeDegrees((sunEquator.ra - SiderealTime(currentTime)) * 15);
    const subsolarLatitude = sunEquator.dec;
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
      sunDirection,
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

  const pinLeft = `${((longitude + 180) / 360) * 100}%`;
  const pinTop = `${((90 - latitude) / 180) * 100}%`;

  return (
    <div className={`app-shell ${activeView === "orbit" ? "orbit-mode" : ""}`}>
      <header className="app-header">
        <div>
          <h1>Sun • Earth • Moon Explorer</h1>
          <p>Uses real astronomical ephemeris data via Astronomy Engine.</p>
        </div>
        <nav className="view-toggle" aria-label="View mode">
          <button className={activeView === "sky" ? "active" : ""} onClick={() => setActiveView("sky")}>
            Sky paths
          </button>
          <button className={activeView === "orbit" ? "active" : ""} onClick={() => setActiveView("orbit")}>
            Earth & Moon
          </button>
        </nav>
      </header>

      {activeView === "sky" ? (
        <>
          <div className="sky-controls-row">
            <section className="controls-grid">
              <label>
                Year
                <input type="number" min={1} max={9999} value={year} onChange={(event) => setYear(Number(event.target.value))} />
              </label>
              <label>
                Month
                <input type="number" min={1} max={12} value={month} onChange={(event) => setMonth(Number(event.target.value))} />
              </label>
              <label>
                Day
                <input type="number" min={1} max={31} value={day} onChange={(event) => setDay(Number(event.target.value))} />
              </label>
              <label>
                UTC Time
                <input type="range" min={0} max={24 * 60 - 1} value={minutesUtc} onChange={(event) => setMinutesUtc(Number(event.target.value))} />
                <span>
                  {toUtcMinutesLabel(minutesUtc)} • {toLocalSolarTimeLabel(minutesUtc, longitude)}
                </span>
              </label>
              <label>
                Latitude
                <input type="number" step={0.0001} min={-90} max={90} value={latitude} onChange={(event) => setLatitude(Number(event.target.value))} />
              </label>
              <label>
                Longitude
                <input type="number" step={0.0001} min={-180} max={180} value={longitude} onChange={(event) => setLongitude(Number(event.target.value))} />
              </label>
              <label>
                Facing direction ({Math.round(facingDegrees)}° • {toCompassDirection(facingDegrees)})
                <input type="range" min={0} max={359} value={facingDegrees} onChange={(event) => setFacingDegrees(Number(event.target.value))} />
              </label>
              <section className="local-almanac" aria-label="Local sun and moon almanac">
                <div className="almanac-times">
                  <div>
                    <span>Sunrise</span>
                    <strong>{toLocalSolarEventLabel(localAlmanac.sunRise, localDayStartUtc)}</strong>
                  </div>
                  <div>
                    <span>Sunset</span>
                    <strong>{toLocalSolarEventLabel(localAlmanac.sunSet, localDayStartUtc)}</strong>
                  </div>
                  <div>
                    <span>Moonrise</span>
                    <strong>{toLocalSolarEventLabel(localAlmanac.moonRise, localDayStartUtc)}</strong>
                  </div>
                  <div>
                    <span>Moonset</span>
                    <strong>{toLocalSolarEventLabel(localAlmanac.moonSet, localDayStartUtc)}</strong>
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
                <div className="earth-pin" style={{left: pinLeft, top: pinTop}} />
              </div>
            </section>
          </div>

          <section className="panel">
            <h2>Observer sky view</h2>
            <p>Human observer view: center is the direction you face; left/right show relative azimuth. The white line is the horizon. Solid arcs are rise-to-set paths; faint dashed arcs are below ground.</p>
            <SkyPathChart sunPath={dayTracks.sunPath} moonPath={dayTracks.moonPath} sunContextPath={dayTracks.sunContextPath} moonContextPath={dayTracks.moonContextPath} sunNow={currentSky.sunNow} moonNow={currentSky.moonNow} />
            <div className="readout">
              <span>
                Sun: az {currentSky.sunNow.azimuth.toFixed(1)}°, alt {currentSky.sunNow.altitude.toFixed(1)}°
              </span>
              <span>
                Moon: az {currentSky.moonNow.azimuth.toFixed(1)}°, alt {currentSky.moonNow.altitude.toFixed(1)}°
              </span>
            </div>
          </section>
        </>
      ) : (
        <main className="orbit-stage">
          <OrbitView earthOrientation={orbitalState.earthOrientation} moonPosition={orbitalState.moonPosition} sunDirection={orbitalState.sunDirection} />
        </main>
      )}
    </div>
  );
}

export default App;
