# Build known-geometry STEP fixtures with OCP so we can validate occ_probe against exact numbers.
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.gp import gp_Pnt, gp_Ax2, gp_Dir
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.Interface import Interface_Static

Interface_Static.SetCVal_s("write.step.unit", "MM")

def cyl(x, y, z, r, h):
    return BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(x, y, z), gp_Dir(0, 0, 1)), r, h).Shape()

def write(shape, path):
    w = STEPControl_Writer()
    w.Transfer(shape, STEPControl_AsIs)
    w.Write(path)
    print("wrote", path)

# Fixture A: 50 x 30 x 20 block, Ø10 through-hole (depth 20), Ø6 blind hole 8 deep
block = BRepPrimAPI_MakeBox(50.0, 30.0, 20.0).Shape()
block = BRepAlgoAPI_Cut(block, cyl(15, 15, 0, 5.0, 20.0)).Shape()      # Ø10 through
block = BRepAlgoAPI_Cut(block, cyl(35, 15, 12, 3.0, 8.0)).Shape()     # Ø6 blind, 8 deep from top
write(block, "fixture_holes.step")

# Fixture B: 40 x 40 x 2 thin plate -> min wall (thickness) = 2.0 mm everywhere
plate = BRepPrimAPI_MakeBox(40.0, 40.0, 2.0).Shape()
write(plate, "fixture_thinwall.step")
