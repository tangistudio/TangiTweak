import { EventEmitter } from "events";
import { greet } from "tiny-greet";
import { greet as shout } from "shout";

export function greetings(name: string): string {
    const bus = new EventEmitter();
    let out = "";
    bus.on("greet", (n: string) => (out = `${greet(n)} / ${shout(n)}`));
    bus.emit("greet", name);
    return out;
}
