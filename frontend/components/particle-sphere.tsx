"use client"

import type React from "react"
import { useRef, useMemo } from "react"
import { Canvas, useFrame } from "@react-three/fiber"
import * as THREE from "three"

const PARTICLE_COUNT = 800
const SPHERE_RADIUS = 2.5
const COLOR = new THREE.Color("#a5b4fc") // soft indigo/blue

function ParticleSphere({ mouseRef }: { mouseRef: React.MutableRefObject<{ x: number; y: number }> }) {
  const pointsRef = useRef<THREE.Points>(null)
  const linesRef = useRef<THREE.LineSegments>(null)

  // Generate evenly distributed points on a sphere using fibonacci distribution
  const { positions, basePositions, connections } = useMemo(() => {
    const positions = new Float32Array(PARTICLE_COUNT * 3)
    const basePositions: THREE.Vector3[] = []

    // Fibonacci sphere distribution for even spacing
    const phi = Math.PI * (Math.sqrt(5) - 1) // golden angle

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const y = 1 - (i / (PARTICLE_COUNT - 1)) * 2 // y goes from 1 to -1
      const radius = Math.sqrt(1 - y * y)
      const theta = phi * i

      const x = Math.cos(theta) * radius * SPHERE_RADIUS
      const z = Math.sin(theta) * radius * SPHERE_RADIUS
      const yPos = y * SPHERE_RADIUS

      positions[i * 3] = x
      positions[i * 3 + 1] = yPos
      positions[i * 3 + 2] = z
      basePositions.push(new THREE.Vector3(x, yPos, z))
    }

    // Create connections between nearby points
    const connectionIndices: number[] = []
    const maxConnections = 3
    const maxDistance = SPHERE_RADIUS * 0.4

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      let connectionCount = 0
      for (let j = i + 1; j < PARTICLE_COUNT && connectionCount < maxConnections; j++) {
        const dist = basePositions[i].distanceTo(basePositions[j])
        if (dist < maxDistance) {
          connectionIndices.push(i, j)
          connectionCount++
        }
      }
    }

    return { positions, basePositions, connections: new Uint16Array(connectionIndices) }
  }, [])

  // Line positions for connections
  const linePositions = useMemo(() => {
    const linePos = new Float32Array(connections.length * 3)
    for (let i = 0; i < connections.length; i++) {
      const idx = connections[i]
      linePos[i * 3] = basePositions[idx].x
      linePos[i * 3 + 1] = basePositions[idx].y
      linePos[i * 3 + 2] = basePositions[idx].z
    }
    return linePos
  }, [connections, basePositions])

  useFrame((state) => {
    if (!pointsRef.current || !linesRef.current) return
    const time = state.clock.elapsedTime * 0.3

    const pointGeometry = pointsRef.current.geometry
    const pointPositions = pointGeometry.getAttribute("position")

    const lineGeometry = linesRef.current.geometry
    const linePositionsAttr = lineGeometry.getAttribute("position")

    // Subtle mouse influence on rotation
    const targetRotationY = mouseRef.current.x * 0.3
    const targetRotationX = mouseRef.current.y * 0.2

    pointsRef.current.rotation.y += (targetRotationY - pointsRef.current.rotation.y) * 0.02
    pointsRef.current.rotation.x += (targetRotationX - pointsRef.current.rotation.x) * 0.02
    pointsRef.current.rotation.z = time * 0.1

    linesRef.current.rotation.copy(pointsRef.current.rotation)

    // Gentle breathing/pulsing effect
    const breathe = 1 + Math.sin(time * 2) * 0.03

    for (let i = 0; i < PARTICLE_COUNT; i++) {
      const base = basePositions[i]

      // Subtle wave distortion
      const wave = Math.sin(time + base.y * 0.5) * 0.05
      const scale = breathe + wave

      pointPositions.setXYZ(i, base.x * scale, base.y * scale, base.z * scale)
    }

    // Update line positions to match
    for (let i = 0; i < connections.length; i++) {
      const idx = connections[i]
      const base = basePositions[idx]
      const wave = Math.sin(time + base.y * 0.5) * 0.05
      const scale = breathe + wave

      linePositionsAttr.setXYZ(i, base.x * scale, base.y * scale, base.z * scale)
    }

    pointPositions.needsUpdate = true
    linePositionsAttr.needsUpdate = true
  })

  return (
    <group position={[0, 0, 0]}>
      {/* Connection lines */}
      <lineSegments ref={linesRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={connections.length} array={linePositions} itemSize={3} />
        </bufferGeometry>
        <lineBasicMaterial color={COLOR} transparent opacity={0.08} />
      </lineSegments>

      {/* Particles */}
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" count={PARTICLE_COUNT} array={positions} itemSize={3} />
        </bufferGeometry>
        <pointsMaterial color={COLOR} size={0.04} transparent opacity={0.6} sizeAttenuation />
      </points>
    </group>
  )
}

// Radial lines emanating from center - inspired by "Interconnecting Waves"
function RadialLines({ mouseRef }: { mouseRef: React.MutableRefObject<{ x: number; y: number }> }) {
  const groupRef = useRef<THREE.Group>(null)
  const LINE_COUNT = 32
  const LINE_LENGTH = 3.5

  const lines = useMemo(() => {
    return Array.from({ length: LINE_COUNT }, (_, i) => {
      const angle = (i / LINE_COUNT) * Math.PI * 2
      return { angle, index: i }
    })
  }, [])

  useFrame((state) => {
    if (!groupRef.current) return
    const time = state.clock.elapsedTime * 0.5

    groupRef.current.children.forEach((child, i) => {
      if (child instanceof THREE.Line) {
        const geometry = child.geometry as THREE.BufferGeometry
        const positions = geometry.getAttribute("position")

        const angle = (i / LINE_COUNT) * Math.PI * 2

        // Subtle length pulsing based on position
        const pulse = 1 + Math.sin(time * 2 + angle * 2) * 0.15
        const mouseInfluence =
          1 + mouseRef.current.x * Math.cos(angle) * 0.1 + mouseRef.current.y * Math.sin(angle) * 0.1

        const length = LINE_LENGTH * pulse * mouseInfluence

        // Start from center, extend outward
        positions.setXYZ(0, 0, 0, 0)
        positions.setXYZ(1, Math.cos(angle) * length, Math.sin(angle) * length, 0)
        positions.needsUpdate = true

        // Fade based on angle
        const material = child.material as THREE.LineBasicMaterial
        material.opacity = 0.1 + Math.sin(time + angle) * 0.05
      }
    })

    groupRef.current.rotation.z = time * 0.05
  })

  return (
    <group ref={groupRef} position={[0, 0, -1]}>
      {lines.map(({ angle, index }) => {
        const positions = new Float32Array([0, 0, 0, Math.cos(angle) * LINE_LENGTH, Math.sin(angle) * LINE_LENGTH, 0])
        return (
          <line key={index}>
            <bufferGeometry>
              <bufferAttribute attach="attributes-position" count={2} array={positions} itemSize={3} />
            </bufferGeometry>
            <lineBasicMaterial color={COLOR} transparent opacity={0.12} />
          </line>
        )
      })}
    </group>
  )
}

// Orbital ring of dots
function OrbitalRing({
  radius,
  particleCount,
  speed,
  mouseRef,
}: {
  radius: number
  particleCount: number
  speed: number
  mouseRef: React.MutableRefObject<{ x: number; y: number }>
}) {
  const pointsRef = useRef<THREE.Points>(null)

  const positions = useMemo(() => {
    const pos = new Float32Array(particleCount * 3)
    for (let i = 0; i < particleCount; i++) {
      const angle = (i / particleCount) * Math.PI * 2
      pos[i * 3] = Math.cos(angle) * radius
      pos[i * 3 + 1] = Math.sin(angle) * radius
      pos[i * 3 + 2] = 0
    }
    return pos
  }, [particleCount, radius])

  useFrame((state) => {
    if (!pointsRef.current) return
    const time = state.clock.elapsedTime

    pointsRef.current.rotation.z = time * speed
    pointsRef.current.rotation.x = mouseRef.current.y * 0.2
    pointsRef.current.rotation.y = mouseRef.current.x * 0.2
  })

  return (
    <points ref={pointsRef}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" count={particleCount} array={positions} itemSize={3} />
      </bufferGeometry>
      <pointsMaterial color={COLOR} size={0.03} transparent opacity={0.4} sizeAttenuation />
    </points>
  )
}

function Scene({ mouseRef }: { mouseRef: React.MutableRefObject<{ x: number; y: number }> }) {
  return (
    <>
      <ParticleSphere mouseRef={mouseRef} />
      <RadialLines mouseRef={mouseRef} />
      <OrbitalRing radius={3.2} particleCount={60} speed={0.08} mouseRef={mouseRef} />
      <OrbitalRing radius={3.8} particleCount={80} speed={-0.05} mouseRef={mouseRef} />
    </>
  )
}

export function ParticleSphereBackground() {
  const containerRef = useRef<HTMLDivElement>(null)
  const mouseRef = useRef({ x: 0, y: 0 })

  const handleMouseMove = (e: React.MouseEvent) => {
    if (containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect()
      mouseRef.current = {
        x: ((e.clientX - rect.left) / rect.width) * 2 - 1,
        y: -((e.clientY - rect.top) / rect.height) * 2 + 1,
      }
    }
  }

  return (
    <div ref={containerRef} className="fixed inset-0 -z-10" onMouseMove={handleMouseMove}>
      {/* Dark gradient background */}
      <div
        className="absolute inset-0"
        style={{
          background: "radial-gradient(ellipse at center, #0f0f23 0%, #070714 50%, #030308 100%)",
        }}
      />
      <Canvas camera={{ position: [0, 0, 6], fov: 50 }} gl={{ antialias: true, alpha: true }}>
        <Scene mouseRef={mouseRef} />
      </Canvas>
    </div>
  )
}
