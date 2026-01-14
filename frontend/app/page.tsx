"use client"

import { motion } from "framer-motion"
import { ParticleSphereBackground } from "@/components/particle-sphere"
import { Button } from "@/components/ui/button"
import { ArrowRight, Github } from "lucide-react"

export default function Home() {
  return (
    <div className="relative min-h-screen overflow-hidden">
      <ParticleSphereBackground />

      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.8 }}
        className="fixed top-0 left-0 right-0 z-50 px-6 py-4"
      >
        <nav className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-xl font-bold text-white">wealthwise</span>
            <a
              href="https://github.com"
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-8 w-8 items-center justify-center rounded-md text-white/70 transition-colors hover:bg-white/10 hover:text-white"
            >
              <Github className="h-5 w-5" />
            </a>
          </div>
        </nav>
      </motion.header>

      {/* Hero Section */}
      <main className="relative flex min-h-screen flex-col items-center justify-center px-6 pt-20">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1, delay: 0.3 }}
          className="text-center"
        >
          <h1 className="mx-auto max-w-4xl text-balance text-5xl font-bold tracking-tight text-white md:text-7xl">
            <span className="bg-gradient-to-r from-blue-400 via-indigo-400 to-purple-400 bg-clip-text text-transparent">
              wealthwise
            </span>
          </h1>

          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 1, delay: 0.8 }}
            className="mx-auto mt-6 max-w-2xl text-pretty text-lg text-white/60 md:text-xl"
          >
            Institutional-grade risk analysis for your investment portfolio.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 1 }}
            className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row"
          >
            <Button size="lg" className="group bg-indigo-500 text-white hover:bg-indigo-400">
              Start
              <ArrowRight className="ml-2 h-4 w-4 transition-transform group-hover:translate-x-1" />
            </Button>
          </motion.div>
        </motion.div>
      </main>
    </div>
  )
}
