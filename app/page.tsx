import ControlRoom from "./components/ControlRoom";

/**
 * The control room is a client surface because every value it renders is read
 * from the live agent at runtime. Server rendering intentionally produces the
 * connecting state rather than a pre-baked world.
 */
export default function Page() {
  return <ControlRoom />;
}
