import Foundation

/// Pure event simulator mirroring computeUsr.ts and the confirmed-bar Pine
/// state machine. No UIKit/SwiftUI dependencies belong in this layer.
extension UsrEngine {
    static func stablePriorityPrefix<Element>(
        _ values: [Element],
        maximum: Int,
        rankOnlyWhenCapped: Bool = true,
        priority: (Element) -> Double
    ) -> [Element] {
        guard !rankOnlyWhenCapped || values.count > maximum else { return values }
        return Array(values.enumerated().sorted { left, right in
            let leftPriority = priority(left.element)
            let rightPriority = priority(right.element)
            return leftPriority == rightPriority
                ? left.offset < right.offset
                : leftPriority > rightPriority
        }.prefix(maximum).map(\.element))
    }

    static func sideConfluence(_ runtime: Runtime, zones: [UsrZone]) -> [UsrConfluence] {
        let candle = runtime.analysis[runtime.analysisBarId]
        let seededAtr = activeAtr(runtime, candle)
        let currentChartBar = candle.eventChartIndex
        func priority(_ zone: UsrZone) -> Double {
            recencyAdjustedPriority(
                strength(zone, runtime.analysisBarId),
                start: zone.activationBar > 0 ? zone.activationBar : zone.startBar,
                currentChartBar: currentChartBar
            )
        }
        // Pine scans newest-to-oldest and only ranks when the analytical cap
        // is exceeded. Below the cap that order is the deterministic tie-break
        // for equal-price intervals.
        var selected = Array(zones.reversed().filter {
            $0.isActive && strength($0, runtime.analysisBarId) > Constants.confluenceThreshold
        })
        selected = stablePriorityPrefix(
            selected, maximum: Constants.maximumConfluenceCandidates, priority: priority
        )
        let ranged = selected
            .map { zone -> (UsrZone, Double, Double) in
                let tolerance = seededAtr * 0.05
                return zone.isLine
                    ? (zone, zone.top + tolerance, zone.bottom - tolerance)
                    : (zone, zone.top, zone.bottom)
            }
        let candidates = ranged.enumerated().sorted { left, right in
            left.element.2 == right.element.2
                ? left.offset < right.offset
                : left.element.2 < right.element.2
        }.map(\.element)
        var groups: [UsrConfluence] = []
        var comparisons = 0
        guard candidates.count >= 2 else { return groups }
        for first in 0..<(candidates.count - 1) {
            for second in (first + 1)..<candidates.count {
                if comparisons >= 2_000 { break }
                if candidates[second].2 > candidates[first].1 { break }
                comparisons += 1
                var top = min(candidates[first].1, candidates[second].1)
                var bottom = max(candidates[first].2, candidates[second].2)
                guard top >= bottom else { continue }
                var members = [candidates[first].0, candidates[second].0]
                if second + 1 < candidates.count {
                    for third in (second + 1)..<candidates.count {
                        if comparisons >= 2_000 || candidates[third].2 > top { break }
                        comparisons += 1
                        let commonTop = min(top, candidates[third].1)
                        let commonBottom = max(bottom, candidates[third].2)
                        if commonTop >= commonBottom {
                            top = commonTop
                            bottom = commonBottom
                            members.append(candidates[third].0)
                            break
                        }
                    }
                }
                groups.append(UsrConfluence(
                    top: top,
                    bottom: bottom,
                    startBar: members.map { $0.activationBar > 0 ? $0.activationBar : $0.startBar }.max() ?? 0,
                    isMixed: false,
                    memberIds: members.map(\.id),
                    strength: members.map { strength($0, runtime.analysisBarId) }.reduce(0, +)
                        / Double(members.count)
                ))
            }
        }
        return stablePriorityPrefix(groups, maximum: Constants.maximumConfluences) {
            recencyAdjustedPriority($0.strength, start: $0.startBar, currentChartBar: currentChartBar)
        }
    }

    static func rebuildConfluence(_ runtime: Runtime) {
        runtime.supportConfluence = sideConfluence(runtime, zones: runtime.support)
        runtime.resistanceConfluence = sideConfluence(runtime, zones: runtime.resistance)
        var mixed: [UsrConfluence] = []
        var comparisons = 0
        outer: for left in runtime.supportConfluence {
            for right in runtime.resistanceConfluence {
                comparisons += 1
                if comparisons > 2_000 { break outer }
                let top = min(left.top, right.top)
                let bottom = max(left.bottom, right.bottom)
                if top >= bottom {
                    mixed.append(UsrConfluence(top: top, bottom: bottom,
                        startBar: max(left.startBar, right.startBar), isMixed: true,
                        memberIds: [],
                        strength: (left.strength + right.strength) / 2))
                }
            }
        }
        let currentChartBar = runtime.analysis[runtime.analysisBarId].eventChartIndex
        runtime.mixedConfluence = stablePriorityPrefix(mixed, maximum: Constants.maximumConfluences) {
            recencyAdjustedPriority($0.strength, start: $0.startBar, currentChartBar: currentChartBar)
        }
        runtime.lastConfluenceBuild = runtime.analysisBarId
    }

    static func rebuildPoolSide(
        _ runtime: Runtime,
        support: Bool,
        zones input: inout [UsrZone],
        previous: [UsrPool]
    ) -> [UsrPool] {
        for index in input.indices {
            input[index].inPool = false
            input[index].poolId = ""
        }
        let atr = activeAtr(runtime, runtime.analysis[runtime.analysisBarId])
        let tolerance = max(runtime.settings.minimumTick * 2, atr * runtime.settings.poolAtrFactor * 0.15)
        let currentChartBar = runtime.analysis[runtime.analysisBarId].eventChartIndex
        var selected = Array(input.reversed().filter { $0.isActive && $0.isLine && !$0.isFlipped })
        selected = stablePriorityPrefix(selected, maximum: Constants.maximumClusterLevels) {
            recencyAdjustedPriority(
                strength($0, runtime.analysisBarId),
                start: $0.activationBar > 0 ? $0.activationBar : $0.startBar,
                currentChartBar: currentChartBar
            )
        }
        let candidates = selected.enumerated().sorted { left, right in
            left.element.top == right.element.top
                ? left.offset < right.offset
                : left.element.top < right.element.top
        }.map(\.element)
        var pools = previous
        var rebuiltIds = Set<String>()
        var position = 0
        while position < candidates.count {
            let floor = candidates[position].top
            var members = [candidates[position]]
            position += 1
            while position < candidates.count && members.count < 10
                    && candidates[position].top - floor <= tolerance {
                members.append(candidates[position])
                position += 1
            }
            guard members.count >= runtime.settings.poolClusterThreshold else { continue }
            let id = "\(support ? "PS" : "PR")|" + members.map { String($0.id) }.joined(separator: "|")
            let existingIndex = pools.firstIndex { $0.id == id }
            let combined = min(1, members.map { strength($0, runtime.analysisBarId) }.reduce(0, +)
                / Double(members.count) + Double(min(members.count - 1, 4)) * 0.05)
            var pool = existingIndex.map { pools[$0] } ?? UsrPool(
                id: id, top: 0, bottom: 0, strength: combined,
                startBar: runtime.analysis[runtime.analysisBarId].eventChartIndex,
                isSupport: support, state: .anticipated, memberIds: [],
                analysisBirth: runtime.analysisBarId
            )
            pool.top = members.map(\.top).max() ?? 0
            pool.bottom = members.map(\.bottom).min() ?? 0
            pool.strength = combined
            pool.memberIds = members.map(\.id)
            if let existingIndex { pools[existingIndex] = pool } else { pools.append(pool) }
            rebuiltIds.insert(id)
        }
        let maximum = support ? runtime.settings.maxSupportPools : runtime.settings.maxResistancePools
        var retained = pools.filter { rebuiltIds.contains($0.id) }
        while retained.count > maximum {
            var weakestIndex = 0
            for index in retained.indices.dropFirst() {
                let candidate = retained[index]
                let weakest = retained[weakestIndex]
                if candidate.strength < weakest.strength
                    || (candidate.strength == weakest.strength && candidate.startBar < weakest.startBar) {
                    weakestIndex = index
                }
            }
            retained.remove(at: weakestIndex)
        }
        for pool in retained {
            for index in input.indices where pool.memberIds.contains(input[index].id) {
                input[index].inPool = true
                input[index].poolId = pool.id
            }
        }
        return retained
    }

    static func updatePoolSide(_ runtime: Runtime, pools: [UsrPool], zones: inout [UsrZone]) -> [UsrPool] {
        let candle = runtime.analysis[runtime.analysisBarId]
        let epsilon = runtime.settings.minimumTick * Double(runtime.settings.breakBufferTicks)
        var retained: [UsrPool] = []
        for var pool in pools {
            guard runtime.analysisBarId > pool.analysisBirth else {
                retained.append(pool)
                continue
            }
            let invalid = force(runtime, candle)
                && (pool.isSupport ? below(runtime, candle.close, pool.bottom) : above(runtime, candle.close, pool.top))
            if invalid {
                for index in zones.indices where zones[index].poolId == pool.id {
                    zones[index].inPool = false
                    zones[index].poolId = ""
                }
                continue
            }
            let interacting = candle.high >= pool.bottom && candle.low <= pool.top
            let swept = pool.isSupport
                ? below(runtime, candle.low, pool.bottom) && candle.close >= pool.top - epsilon
                : above(runtime, candle.high, pool.top) && candle.close <= pool.bottom + epsilon
            if swept { pool.state = .swept }
            else if interacting && pool.state == .anticipated { pool.state = .validated }
            retained.append(pool)
        }
        return retained
    }

    static func processDerived(_ runtime: Runtime) {
        if runtime.zonesChanged || runtime.lastConfluenceBuild < 0
            || runtime.analysisBarId - runtime.lastConfluenceBuild >= 5 {
            rebuildConfluence(runtime)
        }
        guard runtime.settings.showLiquidityPools else {
            runtime.supportPools = []
            runtime.resistancePools = []
            return
        }
        if runtime.zonesChanged || runtime.lastPoolBuild < 0
            || runtime.analysisBarId - runtime.lastPoolBuild >= 10 {
            var supportZones = runtime.support
            var resistanceZones = runtime.resistance
            runtime.supportPools = rebuildPoolSide(runtime, support: true,
                zones: &supportZones, previous: runtime.supportPools)
            runtime.resistancePools = rebuildPoolSide(runtime, support: false,
                zones: &resistanceZones, previous: runtime.resistancePools)
            runtime.support = supportZones
            runtime.resistance = resistanceZones
            runtime.lastPoolBuild = runtime.analysisBarId
        }
        var supportZones = runtime.support
        var resistanceZones = runtime.resistance
        runtime.supportPools = updatePoolSide(runtime, pools: runtime.supportPools, zones: &supportZones)
        runtime.resistancePools = updatePoolSide(runtime, pools: runtime.resistancePools, zones: &resistanceZones)
        runtime.support = supportZones
        runtime.resistance = resistanceZones
    }
}
