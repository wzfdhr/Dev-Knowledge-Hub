import { aliasedCall } from "@app/target";
import { generatedCall } from "../dist/generated";
import { packageCall } from "internal-pkg";

aliasedCall();
generatedCall();
packageCall();
