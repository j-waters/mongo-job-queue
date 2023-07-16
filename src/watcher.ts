import type {
    ChangeStreamDocument,
    ChangeStreamInsertDocument,
    ChangeStreamUpdateDocument,
} from "mongodb";
import { getClass, mongoose } from "@typegoose/typegoose";
import { registry } from "./registry";
import type { RegisteredJob } from "./entities/RegisteredJob";
import { JobInstanceModel } from "./entities/JobInstance";
import type { Class } from "./common";

// interface ChangeEvent<T> {
//     operationType: "insert";
//     fullDocument: T;
// }

export class Watcher {
    registry = registry;

    stopCallback?: () => void;
    changeStream?: mongoose.mongo.ChangeStream<
        any,
        mongoose.mongo.ChangeStreamDocument<any>
    >;

    async start() {
        if (this.stopCallback) {
            throw new Error("Watcher already running");
        }

        this.changeStream = mongoose.connection.watch(undefined);

        this.changeStream.on("change", (event) => {
            this.onChange(event);
        });

        return new Promise<void>((resolve) => {
            this.stopCallback = resolve;
        });
    }

    async stop() {
        if (!this.stopCallback || !this.changeStream) 
return;

        await this.changeStream.close();
        this.stopCallback();

        this.stopCallback = undefined;
        this.changeStream = undefined;
    }

    private onChange(event: ChangeStreamDocument) {
        console.log(event);
        if (!checkEvent(event)) {
            return;
        }

        const target = this.getTarget(event);
        if (!target) {
            return;
        }

        const entityId = event.documentKey._id;

        let jobs: RegisteredJob[];
        switch (event.operationType) {
            case "insert":
                jobs = registry.getOnCreatedJobs(target);
                break;
            case "update":
                jobs = registry.getOnChangedJobs(
                    target,
                    generateModifiedFields(
                        event.updateDescription.updatedFields,
                    ),
                );
                break;
        }

        return jobs.map(({ name }) => {
            console.log(`Creating new job instance ${name} for ${entityId}`);
            return JobInstanceModel.create({ jobName: name, entityId });
        });
    }

    private getModel(
        event: ChangeStreamDocument,
    ): mongoose.Model<unknown> | undefined {
        if (!checkEvent(event)) 
return;

        return Object.values(mongoose.models).find(
            (m) => m.collection.collectionName === event.ns.coll,
        );
    }

    private getTarget(event: ChangeStreamDocument): Class | undefined {
        if (!checkEvent(event)) 
return;

        const model = this.getModel(event);
        if (!model) {
            console.warn("No model found", event);
            return;
        }

        const target = getClass(model.modelName);
        if (!target) {
            console.warn("No target found", event, model);
            return;
        }

        return target;
    }
}

function checkEvent(
    event: ChangeStreamDocument,
): event is ChangeStreamInsertDocument | ChangeStreamUpdateDocument {
    switch (event.operationType) {
        case "insert":
        case "update":
            return true;
        default:
            return false;
    }
}

export function generateModifiedFields(
    updated?: Record<string, unknown>,
): string[] {
    if (!updated) {
        return [];
    }

    const fields = Object.keys(updated);
    for (const field of fields) {
        if (field.includes(".")) {
            const parts = field.split(".");
            fields.push(parts.slice(0, -1).join("."));
        }
    }

    return fields;
}