package island

import (
	"math"
	"sort"
)

// spatialEdge 是面积扫描使用的多边形边，允许裁剪交点为分数厘米。
type spatialEdge struct {
	x1, z1 float64 // 起点。
	x2, z2 float64 // 终点。
}

// spatialInterval 是某条垂线与允许区域相交的有限区间。
type spatialInterval struct {
	start float64 // 区间下界。
	end   float64 // 区间上界。
}

// SpatialPlacementRect 只变换占地，不改变用户保存的位置或模型尺寸。
func SpatialPlacementRect(placement SpatialPlacement, footprint SpatialFootprint) SpatialRect {
	width, depth := float64(footprint.WidthCM), float64(footprint.DepthCM)
	if placement.Rotation%2 != 0 {
		width, depth = depth, width
	}
	x, z := float64(placement.XCM), float64(placement.ZCM)
	return SpatialRect{x - width/2, x + width/2, z - depth/2, z + depth/2}
}

// SpatialFootprintCovered 检查完整占地的区域并集；重叠地形不能重复计算面积。
func SpatialFootprintCovered(placement SpatialPlacement, footprint SpatialFootprint, regions []SpatialTerrainRegion, allowed []string) bool {
	if footprint.WidthCM <= 0 || footprint.DepthCM <= 0 || placement.Rotation < 0 || placement.Rotation > 3 {
		return false
	}
	return spatialRectCovered(SpatialPlacementRect(placement, footprint), regions, allowed)
}

// spatialRectCovered 也用于门外通路，其局部边界不必对应可摆放物件。
func spatialRectCovered(rect SpatialRect, regions []SpatialTerrainRegion, allowed []string) bool {
	polygons := make([][]SpatialPoint, 0, len(regions))
	for _, region := range regions {
		for _, terrain := range allowed {
			if terrain == region.Terrain && len(region.Polygon) >= 3 {
				polygons = append(polygons, region.Polygon)
				break
			}
		}
	}
	area := spatialCoveredArea(rect, polygons)
	return math.Abs(area-(rect.MaxXCM-rect.MinXCM)*(rect.MaxZCM-rect.MinZCM)) <= 0.000001
}

// spatialCoveredArea 在所有顶点、边交点和裁剪交点处分条，区间内覆盖长度是线性的。
func spatialCoveredArea(rect SpatialRect, polygons [][]SpatialPoint) float64 {
	xs := []float64{rect.MinXCM, rect.MaxXCM}
	edges := make([]spatialEdge, 0)
	addX := func(x float64) {
		if x > rect.MinXCM && x < rect.MaxXCM {
			xs = append(xs, x)
		}
	}
	for _, polygon := range polygons {
		for index, point := range polygon {
			next := polygon[(index+1)%len(polygon)]
			edge := spatialEdge{float64(point.XCM), float64(point.ZCM), float64(next.XCM), float64(next.ZCM)}
			edges = append(edges, edge)
			addX(edge.x1)
			if edge.z2 != edge.z1 {
				for _, z := range []float64{rect.MinZCM, rect.MaxZCM} {
					t := (z - edge.z1) / (edge.z2 - edge.z1)
					if t > 0 && t < 1 {
						addX(edge.x1 + t*(edge.x2-edge.x1))
					}
				}
			}
		}
	}
	for index, first := range edges {
		for _, second := range edges[index+1:] {
			rx, rz := first.x2-first.x1, first.z2-first.z1
			sx, sz := second.x2-second.x1, second.z2-second.z1
			denominator := rx*sz - rz*sx
			if math.Abs(denominator) < 1e-12 {
				continue
			}
			qx, qz := second.x1-first.x1, second.z1-first.z1
			t, u := (qx*sz-qz*sx)/denominator, (qx*rz-qz*rx)/denominator
			if t >= 0 && t <= 1 && u >= 0 && u <= 1 {
				addX(first.x1 + t*rx)
			}
		}
	}
	sort.Float64s(xs)
	area := 0.0
	for index := 1; index < len(xs); index++ {
		width := xs[index] - xs[index-1]
		if width <= 1e-9 {
			continue
		}
		x := (xs[index] + xs[index-1]) / 2
		intervals := make([]spatialInterval, 0)
		for _, polygon := range polygons {
			zs := make([]float64, 0)
			for edgeIndex, point := range polygon {
				next := polygon[(edgeIndex+1)%len(polygon)]
				x1, x2 := float64(point.XCM), float64(next.XCM)
				if (x1 <= x && x2 > x) || (x2 <= x && x1 > x) {
					zs = append(zs, float64(point.ZCM)+(x-x1)*float64(next.ZCM-point.ZCM)/(x2-x1))
				}
			}
			sort.Float64s(zs)
			for zIndex := 1; zIndex < len(zs); zIndex += 2 {
				start, end := math.Max(zs[zIndex-1], rect.MinZCM), math.Min(zs[zIndex], rect.MaxZCM)
				if end > start {
					intervals = append(intervals, spatialInterval{start, end})
				}
			}
		}
		if len(intervals) == 0 {
			continue
		}
		sort.Slice(intervals, func(i, j int) bool { return intervals[i].start < intervals[j].start })
		start, end, length := intervals[0].start, intervals[0].end, 0.0
		for _, interval := range intervals[1:] {
			if interval.start > end {
				length += end - start
				start, end = interval.start, interval.end
			} else {
				end = math.Max(end, interval.end)
			}
		}
		area += width * (length + end - start)
	}
	return area
}

// spatialRectsOverlap 允许边界相接，只有内部交叠才算互相占用。
func spatialRectsOverlap(first, second SpatialRect) bool {
	return first.MinXCM < second.MaxXCM && first.MaxXCM > second.MinXCM && first.MinZCM < second.MaxZCM && first.MaxZCM > second.MinZCM
}
