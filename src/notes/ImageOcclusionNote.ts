import { Note } from "./Note";
import '@logseq/libs'
import { escapeClozeAndSecoundBrace, safeReplace } from '../utils/utils';
import _ from 'lodash';
import {MD_IMAGE_EMBEDED_REGEXP, MD_PROPERTIES_REGEXP, ORG_PROPERTIES_REGEXP} from "../constants";
import { LogseqProxy } from "../logseq/LogseqProxy";
import {convertToHTMLFile, HTMLFile, processProperties} from "../converter/Converter";
import {SelectPrompt} from "../ui/SelectPrompt";
import {OcclusionEditor} from "../ui/OcclusionEditor";
import getUUIDFromBlock from "../logseq/getUUIDFromBlock";
import {BlockEntity} from "@logseq/libs/dist/LSPlugin";

export class ImageOcclusionNote extends Note {
    public type: string = "image_occlusion";

    public constructor(uuid: string, content: string, format: string, properties: any, page: any) {
        super(uuid, content, format, properties, page);
    }

    public static initLogseqOperations = (() => {
        logseq.Editor.registerBlockContextMenuItem("Image Occlusion", async (block) => {
            let uuid = getUUIDFromBlock(block as BlockEntity);
            block = await logseq.Editor.getBlock(uuid); // Dont use LogseqProxy.Editor.getBlock() here. It will cause a bug due to activeCache.
            let block_content = block.content; // Process pdf properties
            let block_images = ((await processProperties(block_content)).match(MD_IMAGE_EMBEDED_REGEXP) || []).map((block_image) => {
                return block_image.replace(MD_IMAGE_EMBEDED_REGEXP, "$1");
            });
            block_images = _.uniq(block_images);
            if (block_images.length == 0) {await logseq.UI.showMsg("No images found in this block.", "warning"); return;}
            let imgToOcclusionArrHashMap = JSON.parse(Buffer.from(block.properties?.occlusion || Buffer.from("{}", 'utf8').toString('base64'), 'base64').toString());
            console.log("imgToOcclusionArrHashMap", imgToOcclusionArrHashMap);
            let selectedImage = await SelectPrompt("Select Image to add / update occlusion", block_images);
            if (selectedImage) {
                let newOcclusionArr = await OcclusionEditor(selectedImage, imgToOcclusionArrHashMap[selectedImage] || []);
                console.log("newOcclusionArr", newOcclusionArr);
                if (newOcclusionArr) {
                    imgToOcclusionArrHashMap[selectedImage] = newOcclusionArr;
                    if(Buffer.from(JSON.stringify(imgToOcclusionArrHashMap), 'utf8').toString('base64') == block.properties?.occlusion) console.log("No change");
                    await LogseqProxy.Editor.upsertBlockProperty(uuid, 'occlusion', Buffer.from(JSON.stringify(imgToOcclusionArrHashMap), 'utf8').toString('base64'));
                }
            }
        });
    });

    public async getClozedContentHTML(): Promise<HTMLFile> {
        let clozedContent : string = this.content;
        let imgToOcclusionArrHashMap = JSON.parse(Buffer.from(this.properties?.occlusion, 'base64').toString());

        let clozes = new Set();
        for(let image in imgToOcclusionArrHashMap) {
            let occlusionArr = imgToOcclusionArrHashMap[image];
            let block_images = (await processProperties(this.content)).match(MD_IMAGE_EMBEDED_REGEXP).map((image) => {
                return image.replace(MD_IMAGE_EMBEDED_REGEXP, "$1");
            });
            if(block_images.includes(image)) {
                for (let occlusion of occlusionArr) {
                    clozes.add(occlusion.cId);
                }
            }
        }
        clozedContent += `\n<div class="hidden">
        ${Array.from(clozes).map((cloze) => `{{c${cloze}:: ::<span id="c${cloze}"></span>}}`).join('')}
        <div id="imgToOcclusionArrHashMap">${JSON.stringify(imgToOcclusionArrHashMap)}</div>
        <img id="localImgBasePath" src="_logseq_anki_sync.css"></img>
        </div>`;

        return convertToHTMLFile(clozedContent, this.format);
    }

    public static async getNotesFromLogseqBlocks(): Promise<ImageOcclusionNote[]> {
        let blocks: any = await LogseqProxy.DB.datascriptQuery(`
        [:find (pull ?b [*])
        :where
          [?b :block/properties ?p]
          [(get ?p :occlusion)]
        ]`);
        blocks = await Promise.all(blocks.map(async (block) => {
            let uuid = getUUIDFromBlock(block[0]);
            let page = (block[0].page) ? await LogseqProxy.Editor.getPage(block[0].page.id) : {};
            block = block[0];
            if(!block.content) {
                block = await LogseqProxy.Editor.getBlock(uuid);
            }
            if(block)
                return new ImageOcclusionNote(uuid, block.content, block.format, block.properties || {}, page);
            else {
                return null;
            }
        }));
        console.log("ImageOcclusionNote Loaded");
        blocks = _.uniqBy(blocks, 'uuid');
        blocks = _.without(blocks, undefined, null);
        blocks = _.filter(blocks, (block) => { // Remove template cards
            return _.get(block, 'properties.template') == null || _.get(block, 'properties.template') == undefined;
        });
        blocks = await Promise.all(_.map(blocks, async (block) => { // Remove blocks that do not have images with occlusion
            try {
                let imgToOcclusionArrHashMap = JSON.parse(Buffer.from(block.properties?.occlusion, 'base64').toString());
                for(let image in imgToOcclusionArrHashMap) {
                    let occlusionArr = imgToOcclusionArrHashMap[image];
                    let blockImages = (await processProperties(block.content)).match(MD_IMAGE_EMBEDED_REGEXP).map((image) => {
                        return image.replace(MD_IMAGE_EMBEDED_REGEXP, "$1");
                    });
                    if(occlusionArr && occlusionArr.length > 0 && blockImages.includes(image))
                        return block;    // Found a valid occlusion! Return true.
                }
            }
            catch (e) { return false; } // Most likely, the occlusion property is not a valid JSON string. Return false.
            return false; // No valid occlusion found. Return false.
        }));
        blocks = _.without(blocks, false);
        // console.log(blocks);
        return blocks;
    }
}
