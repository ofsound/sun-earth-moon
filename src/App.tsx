import {useEffect, useMemo, useRef, useState} from "react";
import {Canvas} from "@react-three/fiber";
import {OrbitControls, Stars} from "@react-three/drei";
import {Body, Equator, GeoVector, HelioVector, Horizon, Observer} from "astronomy-engine";
import {BufferGeometry, Vector3} from "three";
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

const normalizeSignedDegrees = (degrees: number) => {
  let value = degrees;
  while (value > 180) value -= 360;
  while (value < -180) value += 360;
  return value;
};

const toMinutesLabel = (minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${hours.toString().padStart(2, "0")}:${mins.toString().padStart(2, "0")} UTC`;
};

const toDateFromUtcParts = (year: number, month: number, day: number, minutes: number) => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return new Date(Date.UTC(year, month - 1, day, hours, mins, 0, 0));
};

const bodyHorizontal = (body: Body, date: Date, observer: Observer) => {
  const equatorial = Equator(body, date, observer, true, true);
  return Horizon(date, observer, equatorial.ra, equatorial.dec, "normal");
};

const vectorAdd = (left: Vec3, right: Vec3): Vec3 => ({
  x: left.x + right.x,
  y: left.y + right.y,
  z: left.z + right.z,
});

const toRenderVec = (vector: Vec3, scale: number) => [vector.x * scale, vector.z * scale, vector.y * scale] as [number, number, number];

function SkyPathChart({sunPath, moonPath, sunNow, moonNow}: {sunPath: SkyPoint[]; moonPath: SkyPoint[]; sunNow: SkyPoint; moonNow: SkyPoint}) {
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

    const xFromAz = (relativeAzimuth: number) => ((relativeAzimuth + 180) / 360) * width;
    const yFromAlt = (altitude: number) => height - ((altitude + 90) / 180) * height;

    context.clearRect(0, 0, width, height);
    context.fillStyle = "#060911";
    context.fillRect(0, 0, width, height);

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

    const drawPath = (points: SkyPoint[], color: string) => {
      context.strokeStyle = color;
      context.lineWidth = 2;
      context.beginPath();
      points.forEach((point, index) => {
        const x = xFromAz(point.relativeAzimuth);
        const y = yFromAlt(point.altitude);
        if (index === 0) {
          context.moveTo(x, y);
        } else {
          context.lineTo(x, y);
        }
      });
      context.stroke();
    };

    drawPath(sunPath, "#f5bf42");
    drawPath(moonPath, "#7cc3ff");

    const drawNowMarker = (point: SkyPoint, color: string, label: string) => {
      const x = xFromAz(point.relativeAzimuth);
      const y = yFromAlt(point.altitude);
      context.fillStyle = color;
      context.beginPath();
      context.arc(x, y, 5, 0, Math.PI * 2);
      context.fill();

      context.fillStyle = "#e7edf6";
      context.font = "12px system-ui";
      context.fillText(label, x + 8, y - 8);
    };

    drawNowMarker(sunNow, "#ffd15e", "Sun now");
    drawNowMarker(moonNow, "#8bc9ff", "Moon now");
  }, [sunPath, moonPath, sunNow, moonNow]);

  return <canvas className="sky-canvas" ref={canvasRef} />;
}

function OrbitView({sun, earth, moon, earthTrack, moonTrack}: {sun: Vec3; earth: Vec3; moon: Vec3; earthTrack: Vec3[]; moonTrack: Vec3[]}) {
  const scale = 10;
  const earthPosition = toRenderVec(earth, scale);
  const moonPosition = toRenderVec(moon, scale);
  const sunPosition = toRenderVec(sun, scale);
  const earthLine = earthTrack.map((point) => new Vector3(point.x * scale, point.z * scale, point.y * scale));
  const moonLine = moonTrack.map((point) => new Vector3(point.x * scale, point.z * scale, point.y * scale));

  return (
    <div className="orbit-canvas-wrap">
      <Canvas camera={{position: [6, 6, 8], fov: 52}}>
        <color attach="background" args={["#070910"]} />
        <ambientLight intensity={0.55} />
        <pointLight position={[0, 0, 0]} intensity={45} color="#fff4cf" />
        <pointLight position={[5, 4, 6]} intensity={0.8} color="#b9d3ff" />
        <Stars radius={100} depth={80} count={2500} factor={3.2} saturation={0} fade speed={0.4} />

        <mesh position={sunPosition}>
          <sphereGeometry args={[0.35, 32, 32]} />
          <meshStandardMaterial emissive="#ffcc66" emissiveIntensity={2.2} color="#ffdd99" />
        </mesh>

        <mesh position={earthPosition}>
          <sphereGeometry args={[0.2, 32, 32]} />
          <meshStandardMaterial color="#62b2ff" emissive="#1f4d8a" emissiveIntensity={0.9} roughness={0.78} metalness={0.05} />
        </mesh>

        <mesh position={moonPosition}>
          <sphereGeometry args={[0.11, 24, 24]} />
          <meshStandardMaterial color="#f2f5fb" emissive="#96a9c9" emissiveIntensity={0.6} roughness={0.88} metalness={0.02} />
        </mesh>

        <line>
          <bufferGeometry attach="geometry" onUpdate={(geometry: BufferGeometry) => geometry.setFromPoints(earthLine)} />
          <lineBasicMaterial attach="material" color="#4f77ff" />
        </line>

        <line>
          <bufferGeometry attach="geometry" onUpdate={(geometry: BufferGeometry) => geometry.setFromPoints(moonLine)} />
          <lineBasicMaterial attach="material" color="#b9dcff" />
        </line>

        <axesHelper args={[2.8]} />
        <OrbitControls enablePan={false} maxDistance={30} minDistance={2} />
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

  const dayTracks = useMemo(() => {
    const sunPath: SkyPoint[] = [];
    const moonPath: SkyPoint[] = [];

    for (let minute = 0; minute <= 24 * 60; minute += 15) {
      const sampleTime = toDateFromUtcParts(year, month, day, minute);
      const sunHorizontal = bodyHorizontal(Body.Sun, sampleTime, observer);
      const moonHorizontal = bodyHorizontal(Body.Moon, sampleTime, observer);

      sunPath.push({
        azimuth: sunHorizontal.azimuth,
        altitude: sunHorizontal.altitude,
        relativeAzimuth: normalizeSignedDegrees(sunHorizontal.azimuth - facingDegrees),
      });

      moonPath.push({
        azimuth: moonHorizontal.azimuth,
        altitude: moonHorizontal.altitude,
        relativeAzimuth: normalizeSignedDegrees(moonHorizontal.azimuth - facingDegrees),
      });
    }

    return {sunPath, moonPath};
  }, [year, month, day, observer, facingDegrees]);

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
    const sun: Vec3 = {x: 0, y: 0, z: 0};
    const earth = HelioVector(Body.Earth, currentTime);
    const moonGeo = GeoVector(Body.Moon, currentTime, true);
    const moon = vectorAdd(earth, moonGeo);

    const earthTrack: Vec3[] = [];
    for (let dayOffset = -185; dayOffset <= 180; dayOffset += 3) {
      const sample = new Date(currentTime.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const sampleEarth = HelioVector(Body.Earth, sample);
      earthTrack.push({x: sampleEarth.x, y: sampleEarth.y, z: sampleEarth.z});
    }

    const moonTrack: Vec3[] = [];
    for (let dayOffset = -20; dayOffset <= 20; dayOffset += 0.5) {
      const sample = new Date(currentTime.getTime() + dayOffset * 24 * 60 * 60 * 1000);
      const sampleEarth = HelioVector(Body.Earth, sample);
      const sampleMoonGeo = GeoVector(Body.Moon, sample, true);
      const sampleMoon = vectorAdd(sampleEarth, sampleMoonGeo);
      moonTrack.push(sampleMoon);
    }

    return {
      sun,
      earth: {x: earth.x, y: earth.y, z: earth.z},
      moon,
      earthTrack,
      moonTrack,
    };
  }, [currentTime]);

  const pinLeft = `${((longitude + 180) / 360) * 100}%`;
  const pinTop = `${((90 - latitude) / 180) * 100}%`;

  return (
    <div className="app-shell">
      <header>
        <h1>Sun • Earth • Moon Explorer</h1>
        <p>Uses real astronomical ephemeris data via Astronomy Engine. Set location, date, and viewing direction, then switch between sky-path and orbit views.</p>
      </header>

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
          <span>{toMinutesLabel(minutesUtc)}</span>
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
          Facing direction ({Math.round(facingDegrees)}°)
          <input type="range" min={0} max={359} value={facingDegrees} onChange={(event) => setFacingDegrees(Number(event.target.value))} />
        </label>
      </section>

      <section className="pin-panel">
        <h2>Earth pin placement</h2>
        <p>Click anywhere on this real Earth map texture to set observer latitude/longitude.</p>
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

      <section className="view-toggle">
        <button className={activeView === "sky" ? "active" : ""} onClick={() => setActiveView("sky")}>
          Sky paths view
        </button>
        <button className={activeView === "orbit" ? "active" : ""} onClick={() => setActiveView("orbit")}>
          3D orbit view
        </button>
      </section>

      {activeView === "sky" ? (
        <section className="panel">
          <h2>Observer sky view</h2>
          <p>X axis: azimuth relative to your selected viewing direction (−180° to +180°). Y axis: altitude above horizon.</p>
          <SkyPathChart sunPath={dayTracks.sunPath} moonPath={dayTracks.moonPath} sunNow={currentSky.sunNow} moonNow={currentSky.moonNow} />
          <div className="readout">
            <span>
              Sun: az {currentSky.sunNow.azimuth.toFixed(1)}°, alt {currentSky.sunNow.altitude.toFixed(1)}°
            </span>
            <span>
              Moon: az {currentSky.moonNow.azimuth.toFixed(1)}°, alt {currentSky.moonNow.altitude.toFixed(1)}°
            </span>
          </div>
        </section>
      ) : (
        <section className="panel">
          <h2>3D Sun-Earth-Moon orbit view</h2>
          <p>Positions are computed from real ephemeris vectors at the selected UTC instant. Earth and Moon body sizes are visually enlarged for readability.</p>
          <OrbitView sun={orbitalState.sun} earth={orbitalState.earth} moon={orbitalState.moon} earthTrack={orbitalState.earthTrack} moonTrack={orbitalState.moonTrack} />
        </section>
      )}
    </div>
  );
}

export default App;
